// parent-index.test.mjs — PIDX node (incremental-aggregation, D1 keystone).
//
// Proves the compact parent index (_parent-index.js) is a byte-equivalent,
// incrementally-maintained replacement for the reconstruction emitter's
// whole-ledger byId rebuild, and that the emitter's flag-ON path (selected via
// ctx.useParentIndex === true, per design.md §D-2.6) emits reconstructed +
// reconcile.* rows BYTE-IDENTICAL to the flag-OFF full-rescan path.
//
// Coverage (PIDX.md STEP 4 / design.md §D-2):
//   1. index projections == full-scan projections (exciseSeeds/reverseAdj/byId/
//      idempotencyByKey first-occurrence/policyIds ledger-order)
//   2. orphan-BFS parity (computeOrphanSet over index == over full scan)
//   3. tail-merge folds ONLY appended bytes; torn trailing line deferred
//   4. self-heal full-rebuild on shrink
//   5. seekRows ascending-offset order + stale-offset -> miss (never wrong row)
//   6. END-TO-END EQUIVALENCE flag-OFF vs flag-ON: clean emit, idempotent
//      replay, PARENT_EXCISED reject, and a reconciliation SUBSTITUTE stamp
//      (contradicts[]/resolution + reconcile.substitute policy row)
//
// Hermetic discipline: env vars set BEFORE any dynamic import touches config.js
// so the signing key / policy paths land under TMP_ROOT.
//
// Run: node --test test/synthesis/parent-index.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

// -----------------------------------------------------------------------------
// Hermetic env — MUST be set BEFORE any dynamic import touches config.js.
// -----------------------------------------------------------------------------

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-pidx-"));
process.env.MEMORY_ROOT = TMP_ROOT;
process.env.POLICY_BASE_DIR = join(TMP_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TMP_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TMP_ROOT, "ledgers");
process.env.HOOKS_BASE_DIR = join(TMP_ROOT, "hooks");
process.env.DAEMONS_BASE_DIR = join(TMP_ROOT, "daemons");

for (const d of [
  process.env.POLICY_BASE_DIR,
  process.env.STORAGE_BASE_DIR,
  process.env.LEDGERS_BASE_DIR,
  process.env.HOOKS_BASE_DIR,
  process.env.DAEMONS_BASE_DIR,
  join(process.env.STORAGE_BASE_DIR, "sources"),
]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}

process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {}
});

// -----------------------------------------------------------------------------
// Dynamic imports — bind into TMP_ROOT.
// -----------------------------------------------------------------------------

const pidxMod = await import("../../lib/synthesis/_parent-index.js");
const {
  buildParentIndex,
  seekRows,
  buildContradictionSeed,
  _resetParentIndexCache,
  _peekParentIndex,
} = pidxMod;

const emitterMod = await import("../../lib/synthesis/reconstruction-emitter.js");
const { emitReconstruction, __internal, RECONSTRUCT_TOKEN_TYPE } = emitterMod;

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
// Fixture helpers
// -----------------------------------------------------------------------------

let _dirSeq = 0;
function freshLedger(name = "memory") {
  const dir = mkdtempSync(join(TMP_ROOT, `l${_dirSeq++}-`));
  return join(dir, `${name}.jsonl`);
}

function writeRows(path, rows) {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", {
    mode: 0o600,
  });
}

function appendRows(path, rows) {
  appendFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function ledgerLines(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

function lastLine(path) {
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  return JSON.parse(lines[lines.length - 1]);
}

function lastNLines(path, n) {
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  return lines.slice(-n).map((l) => JSON.parse(l));
}

const TS = "2026-06-01T00:00:00.000Z";
function fact(id, content, extra = {}) {
  return { id, ts: TS, kind: "fact", content, ...extra };
}
function reconstructed(id, derivedFrom, extra = {}) {
  return {
    id,
    ts: TS,
    kind: "reconstructed",
    derived_from: derivedFrom,
    content: `reconstructed ${id}`,
    ...extra,
  };
}
function policy(id, targets, extra = {}) {
  return { id, ts: TS, kind: "policy", targets, ...extra };
}

function sortedSet(s) {
  return [...s].sort();
}

// Compare two Map<parentId, Set<childId>> for equal keys + equal ordered child
// lists (both are ledger-ordered so order is meaningful).
function reverseAdjEqual(a, b) {
  const ak = [...a.keys()].sort();
  const bk = [...b.keys()].sort();
  assert.deepEqual(ak, bk, "reverseAdj keys differ");
  for (const k of ak) {
    assert.deepEqual(
      [...a.get(k)],
      [...b.get(k)],
      `reverseAdj children for ${k} differ`,
    );
  }
}

// -----------------------------------------------------------------------------
// Emit-equivalence harness (flag-OFF vs flag-ON)
// -----------------------------------------------------------------------------

const FIXED_NOW = "2026-07-01T00:00:00.000Z";
function ulidFactory() {
  let n = 0;
  return () => `u${String(n++).padStart(4, "0")}`;
}
function offCtx(path) {
  return { ledgerPath: path, now: () => FIXED_NOW, ulid: ulidFactory() };
}
function onCtx(path) {
  return {
    ledgerPath: path,
    useParentIndex: true,
    now: () => FIXED_NOW,
    ulid: ulidFactory(),
  };
}

function mintAgentToken({ content, parents, conversation_id, scope }) {
  const sortedParents = [...parents].sort();
  const bindingObject = {
    content_hash: createHash("sha256")
      .update(Buffer.from(content, "utf8"))
      .digest("hex"),
    parent_set_hash: canonicalJsonSha256Hex(sortedParents),
    conversation_id,
    scope,
  };
  const bindingHash = canonicalJsonSha256Hex(bindingObject);
  return mintToken(bindingHash, RECONSTRUCT_TOKEN_TYPE, SIGNING_KEY, {}).token;
}

// =============================================================================
// CASE 1 — index projections == full-scan projections
// =============================================================================

test("case 1: index projections equal the emitter's full-scan projections", () => {
  _resetParentIndexCache();
  const path = freshLedger();
  const rows = [
    fact("f1", "fact one", {
      source_refs: [{ corroboration_event_id: "corr_x" }],
    }),
    fact("f2", "fact two"),
    reconstructed("r1", ["f1"], { idempotency_key: "K1" }),
    reconstructed("r1b", ["f1"], { idempotency_key: "K1" }), // dup key -> first wins (r1)
    policy("p_excise", ["f2"], { policy_kind: "excise" }), // active excise -> seeds f2
    policy("p_silent", ["f1"], { policy_kind: "excise", silent: true }), // decoy
    policy("p_retain", ["f1"], { policy_kind: "excise", derivation_policy: "retain" }), // decoy
    policy("p_inactive", ["f1"], { policy_kind: "excise", active_inline: false }), // decoy
  ];
  writeRows(path, rows);

  const idx = buildParentIndex(path);
  assert.ok(idx, "index built");

  const all = __internal.scanLedgerLines(path);

  // exciseSeeds
  const fullSeeds = __internal.buildExciseSeedSet(all);
  assert.deepEqual(sortedSet(idx.exciseSeeds), sortedSet(fullSeeds));
  assert.deepEqual(sortedSet(idx.exciseSeeds), ["f2"], "only the active excise seeds");

  // reverseAdj (WIDE): reconstructed.derived_from + fact.source_refs + policy.targets
  const fullAdj = __internal.buildReverseAdj(all);
  reverseAdjEqual(idx.reverseAdj, fullAdj);
  // spot-check specific edges. The WIDE reverseAdj mirrors the emitter's
  // buildReverseAdj: reconstructed.derived_from + fact.source_refs +
  // policy.targets — so f1's children include the decoy policies that target
  // it, in ledger order (this is identical flag-OFF vs flag-ON).
  assert.deepEqual(
    [...idx.reverseAdj.get("f1")],
    ["r1", "r1b", "p_silent", "p_retain", "p_inactive"],
  );
  assert.deepEqual([...idx.reverseAdj.get("corr_x")], ["f1"]); // fact source_ref edge
  assert.deepEqual([...idx.reverseAdj.get("f2")], ["p_excise"]); // policy target edge

  // byId keys + kinds
  assert.deepEqual(
    [...idx.byId.keys()].sort(),
    ["f1", "f2", "p_excise", "p_inactive", "p_retain", "p_silent", "r1", "r1b"],
  );
  assert.equal(idx.byId.get("f1").kind, "fact");
  assert.equal(idx.byId.get("r1").kind, "reconstructed");
  assert.equal(idx.byId.get("p_excise").kind, "policy");
  assert.equal(typeof idx.byId.get("f1").offset, "number");
  assert.equal(typeof idx.byId.get("f1").len, "number");

  // idempotencyByKey — FIRST occurrence wins
  assert.equal(idx.idempotencyByKey.get("K1"), "r1");
  assert.equal(__internal.checkIdempotent("K1", all).prior_memory_id, "r1");

  // policyIds — ALL policy ids, ledger order
  assert.deepEqual(
    [...idx.policyIds],
    ["p_excise", "p_silent", "p_retain", "p_inactive"],
  );
});

// =============================================================================
// CASE 2 — orphan-BFS parity
// =============================================================================

test("case 2: computeOrphanSet over the index equals over the full scan", () => {
  _resetParentIndexCache();
  const path = freshLedger();
  const rows = [
    fact("fa", "ancestor fact"),
    reconstructed("rb", ["fa"]),
    reconstructed("rc", ["rb"]),
    policy("p_ex", ["fa"], { policy_kind: "excise" }),
  ];
  writeRows(path, rows);

  const idx = buildParentIndex(path);
  const all = __internal.scanLedgerLines(path);

  const fullOrphans = __internal.computeOrphanSet(
    __internal.buildExciseSeedSet(all),
    __internal.buildReverseAdj(all),
  );
  const idxOrphans = __internal.computeOrphanSet(idx.exciseSeeds, idx.reverseAdj);

  assert.deepEqual(sortedSet(idxOrphans), sortedSet(fullOrphans));
  // fa excised -> rb, rc transitively orphaned; the excise policy p_ex is also
  // reached via its fa->p_ex target edge (harmless: parents are never policies,
  // and it is identical flag-OFF vs flag-ON).
  assert.deepEqual(sortedSet(idxOrphans), ["fa", "p_ex", "rb", "rc"]);
});

// =============================================================================
// CASE 3 — tail-merge folds only appended bytes; torn tail deferred
// =============================================================================

test("case 3: tail-merge folds only appended bytes and defers a torn tail", () => {
  _resetParentIndexCache();
  const path = freshLedger();
  writeRows(path, [fact("r1", "one"), fact("r2", "two")]);

  const idx1 = buildParentIndex(path);
  const r1EntryBefore = { ...idx1.byId.get("r1") };
  const sizeBefore = idx1.size;
  assert.equal(idx1.size, idx1.fileSize, "clean file: safe offset == file size");

  // Append a reconstructed row referencing r1.
  appendRows(path, [reconstructed("r3", ["r1"])]);
  const idx2 = buildParentIndex(path);

  assert.equal(idx2, idx1, "tail-merge returns the SAME cached object (not a rebuild)");
  assert.deepEqual(
    idx2.byId.get("r1"),
    r1EntryBefore,
    "prior byId entry untouched by tail-merge",
  );
  assert.ok(idx2.byId.has("r3"), "appended row folded");
  assert.deepEqual([...idx2.reverseAdj.get("r1")], ["r3"]);
  assert.ok(idx2.size > sizeBefore, "safe offset advanced past the appended row");

  // Torn trailing line (no newline) must NOT be folded until its \n lands.
  const tornRow = reconstructed("r4", ["r1"]);
  appendFileSync(path, JSON.stringify(tornRow)); // NOTE: no trailing "\n"
  const idx3 = buildParentIndex(path);
  assert.ok(!idx3.byId.has("r4"), "torn trailing line NOT folded");

  appendFileSync(path, "\n"); // complete the line
  const idx4 = buildParentIndex(path);
  assert.ok(idx4.byId.has("r4"), "line folded once its newline lands");
  assert.deepEqual([...idx4.reverseAdj.get("r1")], ["r3", "r4"]);
});

// =============================================================================
// CASE 4 — self-heal full rebuild on shrink
// =============================================================================

test("case 4: shrink triggers a full rebuild reflecting only the new content", () => {
  _resetParentIndexCache();
  const path = freshLedger();
  writeRows(path, [fact("f1", "one"), fact("f2", "two"), fact("f3", "three")]);
  const idxBig = buildParentIndex(path);
  assert.deepEqual([...idxBig.byId.keys()].sort(), ["f1", "f2", "f3"]);

  // Rewrite SMALLER with different content (shrink == append-only violation).
  writeRows(path, [fact("g1", "brand new")]);
  const idxSmall = buildParentIndex(path);

  assert.notEqual(idxSmall, idxBig, "shrink returns a NEW object (full rebuild)");
  assert.deepEqual(
    [...idxSmall.byId.keys()].sort(),
    ["g1"],
    "no stale ids from the larger prior file",
  );
  assert.ok(!idxSmall.byId.has("f1"), "stale id purged by self-heal");
});

// =============================================================================
// CASE 5 — seekRows ordering + stale-offset verification
// =============================================================================

test("case 5: seekRows returns ledger-order rows and rejects stale offsets", () => {
  _resetParentIndexCache();
  const path = freshLedger();
  writeRows(path, [
    fact("a", "first"),
    fact("b", "second"),
    fact("c", "third"),
  ]);
  const idx = buildParentIndex(path);

  // Ask in reverse order — result must come back ASCENDING by offset (ledger order).
  const got = seekRows(path, idx, ["c", "a", "b"]);
  assert.deepEqual([...got.keys()], ["a", "b", "c"]);
  assert.equal(got.get("a").content, "first");
  assert.equal(got.get("c").content, "third");

  // Ids absent from the index are omitted.
  const partial = seekRows(path, idx, ["a", "zzz"]);
  assert.deepEqual([...partial.keys()], ["a"]);

  // Fabricate a STALE offset: point "b" at "a"'s bytes -> parsed id !== wanted -> miss.
  const aOffset = idx.byId.get("a").offset;
  idx.byId.get("b").offset = aOffset;
  const stale = seekRows(path, idx, ["b"]);
  assert.equal(stale.has("b"), false, "stale offset yields a miss, never a wrong row");

  // Garbage offset -> null read -> miss.
  idx.byId.get("b").offset = 10_000_000;
  const garbage = seekRows(path, idx, ["b"]);
  assert.equal(garbage.has("b"), false, "out-of-range offset yields a miss");
});

// =============================================================================
// CASE 5b — buildContradictionSeed produces the narrow parent-scoped seed
// =============================================================================

test("case 5b: buildContradictionSeed = parents ∪ reconstructed-children ∪ policies, narrow reverseAdj", () => {
  _resetParentIndexCache();
  const path = freshLedger();
  writeRows(path, [
    fact("p", "parent fact"),
    reconstructed("rec_child", ["p"]),
    fact("fact_child", "fact child", {
      source_refs: [{ corroboration_event_id: "p" }],
    }),
    policy("pol_child", ["p"], { policy_kind: "excise" }),
    policy("pol_other", ["zzz"], { policy_kind: "exclude", confidence: 0.9 }),
  ]);
  const idx = buildParentIndex(path);

  // WIDE reverseAdj for "p" holds all three child kinds.
  assert.deepEqual([...idx.reverseAdj.get("p")], ["rec_child", "fact_child", "pol_child"]);

  const seed = buildContradictionSeed(idx, ["p"]);
  // neededIds = parent + reconstructed child + ALL policy ids (NOT fact_child).
  assert.deepEqual(
    [...seed.neededIds].sort(),
    ["p", "pol_child", "pol_other", "rec_child"],
  );
  // narrow reverseAdj drops the fact + policy children, keeps reconstructed only.
  assert.deepEqual([...seed.reverseAdj.get("p")], ["rec_child"]);
});

// =============================================================================
// CASE 6 — END-TO-END EQUIVALENCE (flag-OFF vs flag-ON)
// =============================================================================

test("case 6a: clean daemon emit is byte-identical flag-OFF vs flag-ON", async () => {
  _resetParentIndexCache();
  const A = freshLedger("off");
  const B = freshLedger("on");
  const seed = [fact("fact_p", "operator configured en5 for serial control", {
    source_refs: [{ consent_basis: "first_party", event_id: "src1" }],
  })];
  writeRows(A, seed);
  writeRows(B, seed);

  const input = {
    mode: "daemon",
    content: "Aggregated: en5 carries serial control per the operator directive.",
    parents: ["fact_p"],
    scope: "cross_session",
    conversation_id: null,
    confidence: 1.0,
    agent_role: "thread-aggregator",
    aggregator_name: "thread-aggregator",
    bucket_key: "2026-06-01",
  };

  const resOff = await emitReconstruction({ ...input }, offCtx(A));
  const resOn = await emitReconstruction({ ...input }, onCtx(B));

  assert.equal(resOff.ok, true);
  assert.equal(resOn.ok, true);
  assert.deepEqual(resOn, resOff, "return values equal");

  const rowOff = lastLine(A);
  const rowOn = lastLine(B);
  assert.equal(rowOff.kind, "reconstructed");
  assert.deepEqual(rowOn, rowOff, "reconstructed rows byte-identical");
});

test("case 6b: idempotent replay returns the same prior id flag-OFF vs flag-ON", async () => {
  _resetParentIndexCache();
  const A = freshLedger("off");
  const B = freshLedger("on");
  const seed = [fact("fact_p", "parent for replay", {
    source_refs: [{ consent_basis: "first_party" }],
  })];
  writeRows(A, seed);
  writeRows(B, seed);

  const input = {
    mode: "daemon",
    content: "Replay content that dedupes on the second emit for the same bucket.",
    parents: ["fact_p"],
    scope: "cross_session",
    conversation_id: null,
    confidence: 1.0,
    aggregator_name: "thread-aggregator",
    bucket_key: "2026-06-02",
  };

  // First emit appends the reconstructed row.
  const first_off = await emitReconstruction({ ...input }, offCtx(A));
  const first_on = await emitReconstruction({ ...input }, onCtx(B));
  assert.equal(first_off.dedupe_action, "appended");
  assert.equal(first_on.dedupe_action, "appended");
  assert.deepEqual(first_on, first_off);

  // Second emit dedupes (flag-ON via tail-merge picking up the row it appended).
  const replay_off = await emitReconstruction({ ...input }, offCtx(A));
  const replay_on = await emitReconstruction({ ...input }, onCtx(B));
  assert.equal(replay_off.dedupe_action, "rejected_idempotent");
  assert.equal(replay_on.dedupe_action, "rejected_idempotent");
  assert.equal(replay_off.memory_event_id, first_off.memory_event_id);
  assert.deepEqual(replay_on, replay_off, "replay return equal + same prior id");
});

test("case 6c: PARENT_EXCISED reject is identical flag-OFF vs flag-ON", async () => {
  _resetParentIndexCache();
  const A = freshLedger("off");
  const B = freshLedger("on");
  const seed = [
    fact("fact_p", "a parent that gets excised"),
    policy("pol_ex", ["fact_p"], { policy_kind: "excise" }),
  ];
  writeRows(A, seed);
  writeRows(B, seed);

  const input = {
    mode: "daemon",
    content: "Derivation from an excised parent must be rejected on both paths.",
    parents: ["fact_p"],
    scope: "cross_session",
    conversation_id: null,
    confidence: 1.0,
    aggregator_name: "thread-aggregator",
    bucket_key: "2026-06-03",
  };

  const resOff = await emitReconstruction({ ...input }, offCtx(A));
  const resOn = await emitReconstruction({ ...input }, onCtx(B));

  assert.equal(resOff.ok, false);
  assert.equal(resOff.code, "PARENT_EXCISED");
  assert.deepEqual(resOn, resOff, "reject envelopes identical");
});

test("case 6d: reconciliation SUBSTITUTE stamp is byte-identical flag-OFF vs flag-ON", async () => {
  _resetParentIndexCache();
  const A = freshLedger("off");
  const B = freshLedger("on");
  // Parent + an intra-conversation reconstructed sibling that the new (higher
  // confidence, same conversation/scope/agent-prefix) emission SUBSTITUTES.
  const seed = [
    fact("fact_p", "shared parent for the refinement", {
      source_refs: [{ consent_basis: "first_party" }],
    }),
    reconstructed("rec_sib", ["fact_p"], {
      content: "earlier lower-confidence reconstruction of the same topic",
      scope: "cross_session",
      idempotency_key: "seed-sib-key",
      provenance: {
        agent_id: "claude-code:conv-sub",
        conversation_id: "conv-sub",
        confidence: 0.6,
      },
    }),
  ];
  writeRows(A, seed);
  writeRows(B, seed);

  const content =
    "Refined higher-confidence reconstruction that supersedes the earlier sibling.";
  const parents = ["fact_p"];
  const conversation_id = "conv-sub";
  const scope = "cross_session";
  const baseInput = {
    mode: "agent",
    content,
    parents,
    scope,
    conversation_id,
    confidence: 0.95,
  };

  const resOff = await emitReconstruction(
    { ...baseInput, token: mintAgentToken({ content, parents, conversation_id, scope }) },
    offCtx(A),
  );
  const resOn = await emitReconstruction(
    { ...baseInput, token: mintAgentToken({ content, parents, conversation_id, scope }) },
    onCtx(B),
  );

  assert.equal(resOff.ok, true, "flag-OFF emit succeeded");
  assert.equal(resOn.ok, true, "flag-ON emit succeeded");
  assert.deepEqual(resOn, resOff, "emit return values equal");

  // The stamp is actually exercised (design.md requires a substitute/co_exist).
  assert.equal(resOff.resolution, "substitute", "substitute resolution reached");
  assert.deepEqual(resOff.contradicts, ["rec_sib"], "sibling stamped as contradicted");

  // Both paths append TWO rows: the reconstructed row + the reconcile.substitute policy.
  const [recOff, polOff] = lastNLines(A, 2);
  const [recOn, polOn] = lastNLines(B, 2);

  assert.equal(recOff.kind, "reconstructed");
  assert.equal(recOff.resolution, "substitute");
  assert.deepEqual(recOff.contradicts, ["rec_sib"]);
  assert.deepEqual(recOn, recOff, "reconstructed row (with contradicts/resolution) byte-identical");

  assert.equal(polOff.kind, "policy");
  assert.equal(polOff.policy_kind, "reconcile.substitute");
  assert.deepEqual(polOn, polOff, "reconcile.substitute policy row byte-identical");
});

// =============================================================================
// CASE 7 — missing ledger under flag-ON behaves as an empty ledger
// =============================================================================

test("case 7: flag-ON over a missing ledger rejects PARENT_NOT_FOUND (empty-ledger parity)", async () => {
  _resetParentIndexCache();
  const missing = join(TMP_ROOT, "does-not-exist", "memory.jsonl");
  const res = await emitReconstruction(
    {
      mode: "daemon",
      content: "No ledger exists, so the parent cannot be found on the index path.",
      parents: ["fact_missing"],
      scope: "cross_session",
      conversation_id: null,
      confidence: 1.0,
      aggregator_name: "thread-aggregator",
      bucket_key: "2026-06-04",
    },
    { ledgerPath: missing, useParentIndex: true, now: () => FIXED_NOW, ulid: ulidFactory() },
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, "PARENT_NOT_FOUND");
});
