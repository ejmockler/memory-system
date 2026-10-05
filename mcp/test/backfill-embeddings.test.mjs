// backfill-embeddings.test.mjs — Phase 3 v0 recall layer.
//
// Hermetic discipline (standing C-NEW-2 pattern): set MEMORY_ROOT and the
// POLICY/STORAGE/LEDGERS dirs to mkdtempSync paths BEFORE any dynamic import
// of memory-system modules. The production tree (the live install) must
// not be touched.
//
// Scope: exercises runBackfill() with --dry-run against a synthetic ledger.
// The dry-run path performs ZERO embed calls (we still pass a stub `embed`
// that throws-on-call as a belt-and-braces assertion that the dry-run code
// path never invokes the Gemini client). Verifies:
//   1. The production tree is untouched.
//   2. Dry-run reports the correct fact_rows + to_embed counts.
//   3. No sidecar / bm25.json / hnsw.bin is written under dry-run.
//   4. The non-dry-run path with a STUBBED embed function writes a valid
//      sidecar + BM25 + HNSW index and round-trips through Bm25Index +
//      HnswIndex deserialization. (No network call.)

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

import { skipIfDaemonActive } from "./_hermetic-daemon-skip.mjs";
skipIfDaemonActive("backfill-embeddings");

// ---------------------------------------------------------------------------
// Hermeticity: stake out tmp dirs BEFORE any dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-backfill-test-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");
// Production-snapshot capture happens BEFORE backfill imports so a path-
// divergence regression manifests as a snapshot mismatch.
const PROD_MEMORY_ROOT = join(homedir(), "memory-system");
const PROD_LEDGER = join(PROD_MEMORY_ROOT, "ledgers", "memory.jsonl");
const PROD_INDICES = join(PROD_MEMORY_ROOT, "indices");
function snapshotPath(p) {
  try {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "missing";
  }
}
const PROD_BEFORE = {
  ledger: snapshotPath(PROD_LEDGER),
  indices: snapshotPath(PROD_INDICES),
};

// Dynamic import AFTER env override.
const backfill = await import("../../scripts/backfill-embeddings.mjs");
const { runBackfill } = backfill;

// ---------------------------------------------------------------------------
// Test framework — matches sibling test/*.test.mjs style.
// ---------------------------------------------------------------------------
let failures = 0;
let passes = 0;
function pass(label) {
  passes++;
  console.log(`  pass: ${label}`);
}
function fail(label, err) {
  failures++;
  console.log(`  FAIL: ${label}`);
  if (err) console.log(`        ${err && err.stack ? err.stack : err}`);
}
async function test(label, fn) {
  console.log(`test: ${label}`);
  try {
    await fn();
  } catch (err) {
    fail(label, err);
  }
}

// ---------------------------------------------------------------------------
// Fixture: write a synthetic ledger with two fact rows + one non-fact.
// ---------------------------------------------------------------------------
function writeLedger(rows) {
  const dir = join(MEMORY_ROOT, "ledgers");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "memory.jsonl");
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return path;
}

const FIXTURE = [
  {
    id: "mem_fixture_a",
    kind: "fact",
    content: "Alex maintains the greenhouse sensors for Example Labs on weekends.",
    source_refs: [
      {
        source: "chat-claude-code",
        source_msg_id: "x1",
        via: "original",
        corroboration_event_id: null,
        consent_basis: "first_party",
      },
    ],
    derived_from: [],
    provenance: {
      agent_id: "test",
      conversation_id: "conv_smoke",
      confidence: "medium",
    },
    created_at: "2026-06-01T00:00:00Z",
  },
  {
    id: "mem_fixture_b",
    kind: "fact",
    content: "Backfill script wires per-version indices for recall.",
    source_refs: [
      {
        source: "chat-claude-code",
        source_msg_id: "x2",
        via: "original",
        corroboration_event_id: null,
        consent_basis: "first_party",
      },
    ],
    derived_from: [],
    provenance: {
      agent_id: "test",
      conversation_id: "conv_smoke",
      confidence: "medium",
    },
    created_at: "2026-06-01T00:00:01Z",
  },
  {
    // non-fact event; backfill must IGNORE this.
    id: "mem_fixture_c",
    kind: "policy",
    content: "ignored by backfill",
    created_at: "2026-06-01T00:00:02Z",
  },
];

writeLedger(FIXTURE);

// ---------------------------------------------------------------------------
// Test 1: --dry-run reports counts WITHOUT calling embed and WITHOUT writing
// any sidecar / bm25 / hnsw files.
// ---------------------------------------------------------------------------
await test("Test 1: --dry-run lists facts, calls no embed, writes nothing", async () => {
  // The embed stub THROWS on invocation; dry-run must never reach it.
  const embedStub = async () => {
    throw new Error("embed stub: should not be called under --dry-run");
  };
  // Silence stdout for deterministic test logs.
  const logged = [];
  const logger = { log: (...a) => logged.push(a.join(" ")), warn: () => {} };

  const summary = await runBackfill({
    dryRun: true,
    sleepMs: 0,
    embed: embedStub,
    logger,
    now: () => Date.parse("2026-06-02T00:00:00Z"),
  });

  assert.equal(summary.dry_run, true, "summary.dry_run=true");
  assert.equal(summary.fact_rows, 2, "fact_rows=2 (non-fact ignored)");
  assert.equal(summary.to_embed, 2, "to_embed=2 (both facts lack embeddings)");
  assert.equal(summary.embedded, 0, "embedded=0 under dry-run");
  assert.equal(summary.bm25_size, 0, "bm25_size=0 under dry-run");
  assert.equal(summary.hnsw_size, 0, "hnsw_size=0 under dry-run");

  // No sidecar / bm25.json / hnsw.bin should exist.
  const indicesDir = join(MEMORY_ROOT, "indices", "gemini-embedding-001");
  assert.equal(
    existsSync(join(indicesDir, "embeddings-sidecar.jsonl")),
    false,
    "no sidecar under dry-run",
  );
  assert.equal(
    existsSync(join(indicesDir, "bm25.json")),
    false,
    "no bm25.json under dry-run",
  );
  assert.equal(
    existsSync(join(indicesDir, "hnsw.bin")),
    false,
    "no hnsw.bin under dry-run",
  );

  // The logger should have captured at least one WOULD line per fact.
  const wouldLines = logged.filter((l) => l.includes("WOULD embed"));
  assert.equal(wouldLines.length, 2, "two WOULD-embed log lines");

  pass("dry-run reports counts, writes nothing, never calls embed");
});

// ---------------------------------------------------------------------------
// Test 2: non-dry-run with a stub embed writes a valid sidecar + indices.
// ---------------------------------------------------------------------------
await test("Test 2: non-dry-run with stub embed writes sidecar + indices", async () => {
  // Build a deterministic 3072d unit-norm vector. Each vector is a one-hot
  // in the FIRST 768 dims (so the MRL slice is also nonzero and renormalizes
  // cleanly). Distinct seeds get distinct active coords -> distinct vectors.
  function unitVec(seed) {
    const v = new Array(3072).fill(0);
    const idx = Math.abs(seed) % 768;
    v[idx] = 1;
    return v;
  }

  let callCount = 0;
  const embedStub = async ({ items, taskType }) => {
    callCount++;
    // Hard-assert the taskType matches the spec (RETRIEVAL_DOCUMENT at
    // promote/backfill time).
    assert.equal(taskType, "RETRIEVAL_DOCUMENT", "stub: taskType=RETRIEVAL_DOCUMENT");
    return items.map((text, i) => ({
      index: i,
      vector_3072: unitVec(text.length * 31 + i),
      vector_mrl_renormalized: null,
      embedding_model_version: "gemini-embedding-001",
    }));
  };

  const logged = [];
  const logger = { log: (...a) => logged.push(a.join(" ")), warn: () => {} };

  const summary = await runBackfill({
    dryRun: false,
    sleepMs: 0,
    embed: embedStub,
    logger,
    now: () => Date.parse("2026-06-02T00:00:00Z"),
  });

  assert.equal(summary.dry_run, false, "summary.dry_run=false");
  assert.equal(summary.embedded, 2, "embedded=2");
  assert.equal(summary.bm25_size, 2, "bm25 has 2 docs");
  assert.equal(summary.hnsw_size, 2, "hnsw has 2 vectors");
  assert.equal(callCount, 1, "embed called exactly once (single chunk)");

  // Sidecar file exists with 2 lines.
  const sidecarPath = join(MEMORY_ROOT, "indices", "gemini-embedding-001", "embeddings-sidecar.jsonl");
  assert.equal(existsSync(sidecarPath), true, "sidecar exists");
  const sidecarRaw = readFileSync(sidecarPath, "utf8");
  const sidecarLines = sidecarRaw.split("\n").filter((l) => l !== "");
  assert.equal(sidecarLines.length, 2, "2 sidecar lines");

  // Sidecar row shape: required fields present, embedding has 3072d unit norm.
  for (const line of sidecarLines) {
    const row = JSON.parse(line);
    assert.equal(typeof row.memory_id, "string");
    assert.equal(row.embedding_3072.length, 3072, "embedding_3072 has 3072 dims");
    assert.equal(row.embedding_mrl_768.length, 768, "embedding_mrl_768 has 768 dims");
    assert.equal(row.embedding_model_version, "gemini-embedding-001");
    assert.equal(row.task_type, "RETRIEVAL_DOCUMENT");
    // Unit-norm assertion at the sidecar layer.
    let sq = 0;
    for (let i = 0; i < row.embedding_3072.length; i++) {
      sq += row.embedding_3072[i] * row.embedding_3072[i];
    }
    assert.ok(Math.abs(Math.sqrt(sq) - 1.0) < 1e-6, "3072d vector is unit norm");
  }

  // bm25.json deserializes into a 2-doc Bm25Index.
  const bm25Path = join(MEMORY_ROOT, "indices", "gemini-embedding-001", "bm25.json");
  assert.equal(existsSync(bm25Path), true, "bm25.json exists");
  const { Bm25Index } = await import("../lib/recall/bm25-index.js");
  const bm25 = Bm25Index.deserialize(JSON.parse(readFileSync(bm25Path, "utf8")));
  assert.equal(bm25.size(), 2, "bm25 round-trips with 2 docs");

  // hnsw round-trip (linear-scan backend default in test env).
  const hnswPath = join(MEMORY_ROOT, "indices", "gemini-embedding-001", "hnsw.bin");
  const sidecarFile = existsSync(hnswPath) || existsSync(hnswPath + ".meta.json");
  assert.equal(sidecarFile, true, "hnsw.bin or hnsw.bin.meta.json exists");
  const { HnswIndex } = await import("../lib/recall/hnsw-index.js");
  const hnsw = HnswIndex.load(hnswPath);
  assert.equal(hnsw.size(), 2, "hnsw round-trips with 2 vectors");

  pass("sidecar + bm25 + hnsw written and round-trip via deserialize/load");
});

// ---------------------------------------------------------------------------
// Test 3: second invocation is a no-op for already-embedded facts (idempotent).
// ---------------------------------------------------------------------------
await test("Test 3: re-run without --force is idempotent (zero new embeds)", async () => {
  // Embed stub THROWS — re-run must never call embed since sidecar covers all facts.
  const embedStub = async () => {
    throw new Error("embed stub: should not be called on idempotent re-run");
  };
  const logger = { log: () => {}, warn: () => {} };

  const summary = await runBackfill({
    dryRun: false,
    sleepMs: 0,
    embed: embedStub,
    logger,
    now: () => Date.parse("2026-06-02T01:00:00Z"),
  });

  assert.equal(summary.embedded, 0, "no new embeds on idempotent re-run");
  assert.equal(summary.to_embed, 0, "to_embed=0 because sidecar covers all facts");
  assert.equal(summary.bm25_size, 2, "bm25 still 2 docs");
  assert.equal(summary.hnsw_size, 2, "hnsw still 2 vectors");
  pass("idempotent re-run does not call embed");
});

// ---------------------------------------------------------------------------
// Test 4: production-tree snapshot is unchanged.
// ---------------------------------------------------------------------------
await test("Test 4: production tree untouched", () => {
  const after = {
    ledger: snapshotPath(PROD_LEDGER),
    indices: snapshotPath(PROD_INDICES),
  };
  assert.equal(
    after.ledger,
    PROD_BEFORE.ledger,
    "production memory.jsonl mtime+size unchanged",
  );
  assert.equal(
    after.indices,
    PROD_BEFORE.indices,
    "production indices/ mtime+size unchanged",
  );
  pass("production tree fingerprint unchanged");
});

// ---------------------------------------------------------------------------
// Cleanup tmp dir + exit code.
// ---------------------------------------------------------------------------
try {
  rmSync(TMP_ROOT, { recursive: true, force: true });
} catch (_) {
  // best-effort
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
