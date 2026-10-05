// dedup-compaction.test.mjs — retroactive-dedup-compaction regression gate.
//
// Covers compact-duplicate-facts.mjs (fully hermetic — own tmpdir ledger, no
// production paths touched):
//   - dry-run report: 3 content-clusters of sizes 5,3,1 -> 6 corroboration
//     events to emit (4 + 2 + 0); canonical = earliest per cluster.
//   - --apply emits the events with the recall-reader shape
//     (kind:"policy", policy_kind:"corroboration", targets:[canonical],
//      payload.source_ref); re-run is idempotent (0 new).
//   - empty-content facts are NEVER collapsed.
//   - Thesis #1: the original fact rows are BYTE-UNCHANGED after --apply
//     (only policy events are appended).
//
// WU2-inline-embed-and-remove-gemini-quota-machinery deleted the Part B
// prune-embed-queue-duplicates half (the embed queue it pruned is gone).
//
// HERMETICITY: mkdtempSync root + env vars set BEFORE any dynamic import of
// memory-system modules (standing C-NEW-2 pattern). No production snapshot is
// required because every assertion runs against the tmpdir fixtures; the live
// daemon may mutate the real ledger without affecting this test.
//
// Run: node test/synthesis/dedup-compaction.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Hermetic root + env BEFORE any dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-wu2-dedup-compaction-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
const POLICY_DIR = join(MEMORY_ROOT, "policy");
const STORAGE_DIR = join(MEMORY_ROOT, "storage");
const LEDGERS_DIR = join(MEMORY_ROOT, "ledgers");
for (const d of [POLICY_DIR, STORAGE_DIR, LEDGERS_DIR]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = POLICY_DIR;
process.env.STORAGE_BASE_DIR = STORAGE_DIR;
process.env.LEDGERS_BASE_DIR = LEDGERS_DIR;

process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ---------------------------------------------------------------------------
// Dynamic imports AFTER env override.
// ---------------------------------------------------------------------------
const compactMod = await import("../../scripts/compact-duplicate-facts.mjs");
const {
  runCompaction,
  scanLedgerForClusters,
  buildRetroactiveCorroboration,
  COMPACT_DUPLICATE_FACTS_VERSION,
  COMPACT_DUPLICATE_FACTS_CAPS,
} = compactMod;

// WU2-inline-embed-and-remove-gemini-quota-machinery deleted
// prune-embed-queue-duplicates.mjs (Part B) along with the embed-queue it
// pruned. Only the compact-duplicate-facts (Part A) retroactive-corroboration
// tooling remains; it is independent of the embedding path.

// ---------------------------------------------------------------------------
// Fixture builders.
//
// Three content-clusters, by ledger (= earliest) order:
//   cluster X (size 5): ids x1..x5, content "alpha duplicate fact"
//   cluster Y (size 3): ids y1..y3, content "beta duplicate fact"
//   cluster Z (size 1): id  z1,     content "gamma singleton fact"
// Plus two empty-content facts e1, e2 (NEVER collapsed) interleaved so we
// prove they don't merge with each other or anything else.
// ---------------------------------------------------------------------------

function factRow(id, content, source = "imessage") {
  return {
    id,
    kind: "fact",
    content,
    source,
    source_refs: [
      { source, source_msg_id: `${source}:${id}`, consent_basis: "first_party" },
    ],
    created_at: "2026-06-01T00:00:00.000Z",
  };
}

// Build the fixture ledger. Returns the path + the JSONL string we wrote.
function writeFixtureLedger(ledgerPath) {
  const rows = [
    factRow("x1", "alpha duplicate fact"),
    factRow("y1", "beta duplicate fact"),
    factRow("x2", "alpha duplicate fact"),
    factRow("e1", ""), // empty content — never collapsed
    factRow("z1", "gamma singleton fact"),
    factRow("x3", "alpha duplicate fact"),
    factRow("y2", "beta duplicate fact"),
    factRow("e2", "   "), // whitespace-only — normalizes to "" — never collapsed
    factRow("x4", "ALPHA Duplicate   Fact"), // normalizes to x1's content
    factRow("y3", "beta duplicate fact"),
    factRow("x5", "alpha duplicate fact"),
  ];
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(ledgerPath, body, { mode: 0o600 });
  return body;
}

const FIXED_TS = "2026-06-17T12:00:00.000Z";

// ---------------------------------------------------------------------------
// T1 — module identity surface: VERSION + frozen CAPS exported (WU discipline).
// ---------------------------------------------------------------------------
test("T1: module exports VERSION + frozen CAPS", () => {
  assert.equal(COMPACT_DUPLICATE_FACTS_VERSION, "v1", "compact version is v1");
  assert.ok(Object.isFrozen(COMPACT_DUPLICATE_FACTS_CAPS), "compact CAPS frozen");
  assert.equal(
    COMPACT_DUPLICATE_FACTS_CAPS.REASON,
    "retroactive_content_dedup",
    "distinct retroactive reason",
  );
});

// ---------------------------------------------------------------------------
// T2 — scanLedgerForClusters: earliest is canonical; cluster membership.
// ---------------------------------------------------------------------------
test("T2: scan identifies clusters with earliest-as-canonical", () => {
  const ledgerPath = join(LEDGERS_DIR, "t2-memory.jsonl");
  writeFixtureLedger(ledgerPath);
  const { byContentHash, factRows } = scanLedgerForClusters(ledgerPath);

  // 3 distinct non-empty content hashes (X, Y, Z). Empty/whitespace are
  // null-hash and never enter the map.
  assert.equal(byContentHash.size, 3, "3 distinct non-empty content clusters");
  // 9 content-bearing fact rows counted (5 X + 3 Y + 1 Z); e1/e2 excluded.
  assert.equal(factRows, 9, "9 content-bearing fact rows (empties excluded)");

  // The X cluster: canonical is x1 (earliest), dups are x2,x3,x4,x5.
  let xCluster = null;
  for (const c of byContentHash.values()) {
    if (c.canonicalId === "x1") xCluster = c;
  }
  assert.ok(xCluster != null, "x1 is a canonical");
  assert.equal(xCluster.dups.length, 4, "X cluster has 4 duplicates");
  assert.deepEqual(
    xCluster.dups.map((d) => d.id).sort(),
    ["x2", "x3", "x4", "x5"],
    "X dups are x2..x5 (incl. case/space-normalized x4)",
  );
});

// ---------------------------------------------------------------------------
// T3 — dry-run report: 5 corroboration events to emit (4 + 2 + 0).
// ---------------------------------------------------------------------------
test("T3: dry-run reports 5 corroboration events (4+2+0), canonical_count=3", () => {
  const ledgerPath = join(LEDGERS_DIR, "t3-memory.jsonl");
  const before = writeFixtureLedger(ledgerPath);

  const res = runCompaction({ ledgerPath, apply: false, quiet: true, now: FIXED_TS });
  assert.equal(res.clusters, 2, "2 collapsible clusters (X size5, Y size3); Z is a singleton");
  assert.equal(res.total_duplicates, 6, "6 duplicates total (4 X + 2 Y)");
  assert.equal(res.canonical_count, 3, "3 canonicals (one per distinct content)");
  assert.equal(
    res.corroboration_events_to_emit,
    6,
    "6 events to emit (one per duplicate)",
  );
  assert.equal(res.corroboration_events_emitted, 0, "dry-run emits nothing");
  assert.equal(res.applied, false, "dry-run not applied");

  // Thesis #1 corollary: dry-run NEVER writes — ledger byte-unchanged.
  assert.equal(readFileSync(ledgerPath, "utf8"), before, "dry-run leaves ledger byte-identical");
});

// ---------------------------------------------------------------------------
// T4 — --apply emits the events with the recall-reader shape + Thesis #1
// byte-unchanged original rows.
// ---------------------------------------------------------------------------
test("T4: --apply emits corroboration rows; original fact rows byte-unchanged", () => {
  const ledgerPath = join(LEDGERS_DIR, "t4-memory.jsonl");
  const before = writeFixtureLedger(ledgerPath);
  const beforeLines = before.split("\n").filter((l) => l.length > 0);

  const res = runCompaction({ ledgerPath, apply: true, quiet: true, now: FIXED_TS });
  assert.equal(res.corroboration_events_emitted, 6, "emitted 6 events");
  assert.equal(res.applied, true, "applied");

  const afterRaw = readFileSync(ledgerPath, "utf8");
  const afterLines = afterRaw.split("\n").filter((l) => l.length > 0);

  // THESIS #1 (load-bearing): the original fact rows are the FIRST 11 lines
  // and are BYTE-UNCHANGED; only new policy rows are appended after them.
  assert.equal(afterLines.length, beforeLines.length + 6, "6 lines appended");
  for (let i = 0; i < beforeLines.length; i += 1) {
    assert.equal(
      afterLines[i],
      beforeLines[i],
      `original fact row ${i} is byte-unchanged`,
    );
  }

  // The 6 appended rows are policy.corroboration in the recall-reader shape.
  const appended = afterLines.slice(beforeLines.length).map((l) => JSON.parse(l));
  for (const ev of appended) {
    assert.equal(ev.kind, "policy", "appended row is a policy row");
    assert.equal(ev.policy_kind, "corroboration", "policy_kind=corroboration");
    assert.equal(ev.reason, "retroactive_content_dedup", "distinct retroactive reason");
    assert.ok(Array.isArray(ev.targets) && ev.targets.length === 1, "targets:[canonical]");
    assert.ok(
      ev.payload && ev.payload.source_ref && typeof ev.payload.source_ref === "object",
      "payload.source_ref present (recall reader projects this)",
    );
    assert.equal(
      ev.payload.source_ref.target_memory_id,
      ev.corroborating_id,
      "source_ref points at the duplicate (corroborating fact)",
    );
    // No checksum field — memory.jsonl policy rows are not checksummed (only
    // fact rows are, via distill-promote-fact rowChecksumHex).
    assert.equal(ev.checksum, undefined, "policy corroboration row carries no checksum");
  }

  // The canonical targets are exactly {x1, y1} (Z singleton not collapsed).
  const targets = new Set(appended.map((e) => e.targets[0]));
  assert.deepEqual([...targets].sort(), ["x1", "y1"], "canonical targets are x1, y1");
});

// ---------------------------------------------------------------------------
// T5 — idempotency: re-running --apply emits 0 new events.
// ---------------------------------------------------------------------------
test("T5: re-run --apply is idempotent (0 new events)", () => {
  const ledgerPath = join(LEDGERS_DIR, "t5-memory.jsonl");
  writeFixtureLedger(ledgerPath);

  const first = runCompaction({ ledgerPath, apply: true, quiet: true, now: FIXED_TS });
  assert.equal(first.corroboration_events_emitted, 6, "first run emits 6");

  const afterFirst = readFileSync(ledgerPath, "utf8");

  const second = runCompaction({ ledgerPath, apply: true, quiet: true, now: FIXED_TS });
  assert.equal(
    second.corroboration_events_emitted,
    0,
    "second run emits 0 (idempotent)",
  );
  assert.equal(
    second.already_corroborated_skipped,
    6,
    "second run skips all 6 already-corroborated duplicates",
  );
  assert.equal(
    second.corroboration_events_to_emit,
    0,
    "nothing left to emit",
  );

  // The ledger is byte-unchanged across the no-op re-run.
  assert.equal(readFileSync(ledgerPath, "utf8"), afterFirst, "no-op re-run leaves ledger byte-identical");
});

// ---------------------------------------------------------------------------
// T6 — empty-content facts are NEVER collapsed.
// ---------------------------------------------------------------------------
test("T6: empty-content facts never collapse", () => {
  const ledgerPath = join(LEDGERS_DIR, "t6-memory.jsonl");
  // TWO empty-content facts + one whitespace-only — all normalize to "".
  const rows = [
    factRow("e1", ""),
    factRow("e2", ""),
    factRow("e3", "   \t \n "),
  ];
  writeFileSync(ledgerPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", {
    mode: 0o600,
  });

  const res = runCompaction({ ledgerPath, apply: true, quiet: true, now: FIXED_TS });
  assert.equal(res.clusters, 0, "no collapsible clusters from empty content");
  assert.equal(res.total_duplicates, 0, "zero duplicates");
  assert.equal(res.corroboration_events_emitted, 0, "no events emitted");
  // The empty-content facts must NOT have collapsed together.
  const after = readFileSync(ledgerPath, "utf8");
  assert.ok(!after.includes('"policy_kind":"corroboration"'), "no corroboration appended for empties");
});

// ---------------------------------------------------------------------------
// T7 — buildRetroactiveCorroboration shape unit check.
// ---------------------------------------------------------------------------
test("T7: buildRetroactiveCorroboration produces the recall-reader shape", () => {
  const ev = buildRetroactiveCorroboration(
    "canon_1",
    { id: "dup_1", source: "git-log", consent_basis: "third_party_inferred" },
    FIXED_TS,
  );
  assert.equal(ev.kind, "policy");
  assert.equal(ev.policy_kind, "corroboration");
  assert.deepEqual(ev.targets, ["canon_1"]);
  assert.equal(ev.target_id, "canon_1");
  assert.equal(ev.corroborating_id, "dup_1");
  assert.equal(ev.payload.source_ref.source, "git-log");
  assert.equal(ev.payload.source_ref.target_memory_id, "dup_1");
  assert.equal(ev.payload.source_ref.consent_basis, "third_party_inferred");
  assert.equal(ev.cosine_distance, null, "content-hash dedup has no embedding");
  assert.equal(ev.ts, FIXED_TS);
  assert.ok(typeof ev.id === "string" && ev.id.startsWith("mem_"), "fresh mem_ id");
});

