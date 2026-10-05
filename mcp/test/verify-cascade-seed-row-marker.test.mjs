// verify-cascade-seed-row-marker.test.mjs — R29.5 regression.
//
// Pins the R29.5 seed-row marker convention. Two scenarios:
//
//   T-marker: synthetic ledger with 5 production rows (valid 768d unit
//             vectors) + 2 explicit marker-rows (provenance.is_seed_row=true).
//             verify-cascade MUST skip the 2 marker rows AND sample on the
//             5 production rows; verdict PASS, smoke_rows=2, production_rows=5.
//
//   T-legacy: synthetic ledger with 5 production rows + 2 UNMARKED rows that
//             match the legacy heuristic (conversation_id="conv_smoke" and
//             content="USER: hi\nASSISTANT: hello"). verify-cascade MUST still
//             skip them via the back-compat fallback; verdict PASS,
//             smoke_rows=2, production_rows=5.
//
// HERMETIC: synthetic tmp ledger, no production-disk touch. Invokes the
// verify-cascade-correctness.mjs script as a child process so the test
// exercises the real CLI surface (filter + flag handling + exit code).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { skipIfDaemonActive } from "./_hermetic-daemon-skip.mjs";
skipIfDaemonActive("verify-cascade-seed-row-marker");

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-verify-seed-marker-"));
mkdirSync(TMP_ROOT, { recursive: true, mode: 0o700 });

const CHECKOUT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(CHECKOUT_ROOT, "mcp", "scripts", "verify-cascade-correctness.mjs");
// Use process.execPath so the test runs under the same node binary used by
// the test runner (works whether that's the vendored node or system node).
const NODE_BIN = process.execPath;

// Snapshot the production ledger so we can prove the test never mutates it.
const PROD_LEDGER = join(CHECKOUT_ROOT, "ledgers", "memory.jsonl");
function snapshot(p) {
  try {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "missing";
  }
}
const PROD_BEFORE = snapshot(PROD_LEDGER);

// 768d unit vector.
function unitVec() {
  const v = new Array(768).fill(0);
  v[0] = 1.0;
  return v;
}

// Production-shaped fact row with a valid 768d unit-norm embedding.
function prodRow(i) {
  return {
    id: `mem_prod_${i}`,
    kind: "fact",
    content: `Production-shaped fact row ${i} with substantive prose.`,
    source_refs: [
      {
        source: "imessage",
        source_msg_id: `imsg-prod-${i}`,
        via: "original",
        corroboration_event_id: null,
        consent_basis: "first_party",
      },
    ],
    derived_from: [],
    provenance: {
      agent_id: "test",
      conversation_id: `conv_prod_${i}`,
      confidence: "medium",
    },
    features: { embedding_mrl_768: unitVec() },
    // Post-WIPE_THRESHOLD (2026-06-03T03:57:00Z) — must NOT trip the
    // created_at fallback.
    created_at: "2026-06-04T00:00:00Z",
  };
}

// Explicit marker row: is_seed_row=true.
function markerRow(i) {
  return {
    id: `mem_marker_${i}`,
    kind: "fact",
    content: `Synthetic seed row ${i} that happens NOT to match legacy heuristic.`,
    source_refs: [],
    derived_from: [],
    provenance: {
      agent_id: "test",
      conversation_id: `conv_synthetic_${i}`,
      confidence: "medium",
      is_seed_row: true,
    },
    // Post-WIPE_THRESHOLD too — so ONLY the is_seed_row marker can skip them.
    created_at: "2026-06-04T00:00:00Z",
  };
}

// Legacy-heuristic row: unmarked but conversation_id="conv_smoke" + known
// smoke content.
function legacyRow(i) {
  return {
    id: `mem_legacy_${i}`,
    kind: "fact",
    content: "USER: hi\nASSISTANT: hello",
    source_refs: [],
    derived_from: [],
    provenance: {
      agent_id: "test",
      conversation_id: "conv_smoke",
      confidence: "medium",
    },
    // Post-WIPE_THRESHOLD too — so ONLY the legacy fallback can skip them.
    created_at: "2026-06-04T00:00:00Z",
  };
}

function writeLedger(name, rows) {
  const path = join(TMP_ROOT, name);
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return path;
}

function runVerify(ledgerPath, extraArgs = []) {
  const res = spawnSync(
    NODE_BIN,
    [SCRIPT, `--ledger=${ledgerPath}`, ...extraArgs],
    { encoding: "utf8" }
  );
  let summary = null;
  try {
    summary = JSON.parse(res.stdout);
  } catch {
    // fall through, leave null
  }
  return { code: res.status, summary, stderr: res.stderr, stdout: res.stdout };
}

// ---------------------------------------------------------------------------
// T-marker: explicit is_seed_row=true marker skips, others sample.
// ---------------------------------------------------------------------------
test("T-marker: verify-cascade skips rows where provenance.is_seed_row===true", async () => {
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(prodRow(i));
  rows.push(markerRow(1));
  rows.push(markerRow(2));
  const ledger = writeLedger("t-marker.jsonl", rows);

  const { code, summary, stderr } = runVerify(ledger);
  assert.equal(code, 0, `expected exit 0 (PASS), got ${code} -- stderr=${stderr}`);
  assert.ok(summary, "summary JSON parsed");
  assert.equal(summary.verdict, "PASS", "verdict must be PASS");
  assert.equal(summary.total_rows, 7, "total_rows must include all 7 lines");
  assert.equal(summary.smoke_rows, 2, "the 2 is_seed_row marker rows MUST be filtered");
  assert.equal(summary.production_rows, 5, "the 5 prod rows MUST be the sample pool");
  assert.equal(summary.sampled, 5, "all 5 prod rows sampled (under default sample=100)");
  assert.equal(summary.with_embedding, 5, "all 5 prod rows carry valid 768d unit-norm embeddings");
  assert.equal(summary.without_embedding, 0, "no embedding failures");
});

// ---------------------------------------------------------------------------
// T-legacy: unmarked rows matching legacy heuristic still skipped via fallback.
// ---------------------------------------------------------------------------
test("T-legacy-fallback: verify-cascade still skips legacy unmarked smoke rows via back-compat fallback", async () => {
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(prodRow(i));
  rows.push(legacyRow(1));
  rows.push(legacyRow(2));
  const ledger = writeLedger("t-legacy.jsonl", rows);

  const { code, summary, stderr } = runVerify(ledger);
  assert.equal(code, 0, `expected exit 0 (PASS), got ${code} -- stderr=${stderr}`);
  assert.ok(summary, "summary JSON parsed");
  assert.equal(summary.verdict, "PASS", "verdict must be PASS");
  assert.equal(summary.total_rows, 7, "total_rows must include all 7 lines");
  assert.equal(
    summary.smoke_rows,
    2,
    "the 2 unmarked legacy smoke rows MUST be filtered via fallback heuristic"
  );
  assert.equal(summary.production_rows, 5, "the 5 prod rows MUST be the sample pool");
  assert.equal(summary.with_embedding, 5, "all 5 prod rows pass the embedding check");
  assert.equal(summary.without_embedding, 0, "no embedding failures");
});

// ---------------------------------------------------------------------------
// T-belt-and-braces: assert the production ledger byte-shape was not touched
// at any point in this test run.
// ---------------------------------------------------------------------------
test("T-hermetic: production ledger untouched by this test", async () => {
  const after = snapshot(PROD_LEDGER);
  assert.equal(
    after,
    PROD_BEFORE,
    "production memory.jsonl mtime/size MUST NOT have changed during this test"
  );
});
