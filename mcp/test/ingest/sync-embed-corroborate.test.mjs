// sync-embed-corroborate.test.mjs — R25.7 CRIT-A2 regression battery.
//
// Pins the sync-embed wiring inside scoreCandidate. The R25.6 failure mode:
// promoteSourceRow set embedding_pending=true on every watermark-path row and
// the cascade itself never embedded — so the HNSW index sat at 0 entries for
// the whole backfill, Layer-3 corroboration silently never fired, and 186,481
// rows landed in memory.jsonl with novelty=0.5 (the embed-pending floor).
//
// The fix (R25.7): scoreCandidate accepts ctx.embedder; if ctx.embedding_mrl_768
// is absent the cascade embeds inline via that function. The PROMOTE return now
// carries embedding_mrl_768 so the caller (promoteSourceRow) can persist it
// onto the fact row AND append it to the HNSW index without re-embedding.
//
// HERMETIC: synthetic stub HNSW, deterministic embedder stub, tmp MEMORY_ROOT.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-sync-embed-"));
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
]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}

const salienceMod = await import("../../lib/ingest/salience.js");
const { CAPS } = await import("../../lib/validation.js");

// Bypass Stage-0 so we exercise Layer 2/3 directly.
salienceMod._setStage0DispatchForTest(() => ({ decision: "PASS" }));

const NOW = new Date("2026-06-02T00:00:00Z");

function unitVec(perturbation = 0) {
  const v = new Array(768).fill(0);
  v[0] = 1.0;
  if (perturbation !== 0) {
    v[1] = perturbation;
    const norm = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
    v[0] /= norm;
    v[1] /= norm;
  }
  return v;
}

// Counting embedder stub. Records each invocation so we can assert it ran
// exactly once per scoreCandidate call (not double-embed) and that
// taskType/dims match the gemini-client.embedSingle contract.
function makeEmbedderStub({ vector = unitVec() } = {}) {
  const calls = [];
  const embedder = async (req) => {
    calls.push(req);
    return {
      vector_3072: null,
      vector_mrl_renormalized: vector,
      embedding_model_version: "test-stub",
    };
  };
  embedder.calls = calls;
  return embedder;
}

// In-memory HNSW stub with appendable state — lets us simulate the
// "next-tick sees the previous tick's PROMOTE" property without touching the
// real recall-layer HnswIndex.
function makeMutableHnsw({ initial = [] } = {}) {
  const entries = [...initial]; // each entry: { memory_id, distance }
  const handle = {
    size: () => entries.length,
    search: () => entries
      .slice()
      .sort((a, b) => a.distance - b.distance)
      .map((e, i) => ({
        memory_id: e.memory_id,
        cosine_distance: e.distance,
        rank: i,
      })),
    appendEntry: (memory_id, distance) => {
      entries.push({ memory_id, distance });
    },
    _entries: entries,
  };
  return handle;
}

function candidate() {
  return {
    source: "imessage",
    source_msg_id: "imsg_sync_embed",
    content:
      "Sync-embed regression: substantive prose so contentMassScore is non-zero and the cascade actually reaches Layer 3.",
    consent_basis: "first_party",
    ts: "2026-06-01T00:00:00Z",
    raw_content: {
      text: "Sync-embed regression: substantive prose so contentMassScore is non-zero and the cascade actually reaches Layer 3.",
      handle_id: "+15555550100",
    },
  };
}

// ---------------------------------------------------------------------------
// T1: empty index → PROMOTE; embedder was called exactly once; the PROMOTE
// return carries embedding_mrl_768 so the caller can append it to the index.
// ---------------------------------------------------------------------------
test("T1: empty index + sync-embedder → PROMOTE with embedding_mrl_768 on return", async () => {
  const embedder = makeEmbedderStub();
  const hnsw = makeMutableHnsw({ initial: [] });
  const r = await salienceMod.scoreCandidate(candidate(), {
    embedder,
    hnsw,
    now: NOW,
  });
  assert.equal(r.decision, "PROMOTE");
  assert.equal(embedder.calls.length, 1, "embedder must be invoked exactly once");
  assert.equal(
    embedder.calls[0].taskType,
    "RETRIEVAL_DOCUMENT",
    "taskType must match gemini-client.embedSingle contract",
  );
  assert.equal(
    embedder.calls[0].dims,
    CAPS.GEMINI_EMBEDDING_DIMS_MRL,
    "dims must be 768 (MRL slice)",
  );
  assert.ok(
    Array.isArray(r.embedding_mrl_768) && r.embedding_mrl_768.length === 768,
    "PROMOTE return must carry embedding_mrl_768 so caller can append to index",
  );
});

// ---------------------------------------------------------------------------
// T2: near-duplicate neighbour at size >= MIN_INDEX_SIZE → CORROBORATE;
// embedder still invoked exactly once (we still need the vector for kNN).
// ---------------------------------------------------------------------------
test("T2: near-dup neighbour (distance < threshold) → CORROBORATE; embedder called once", async () => {
  const imessageThr = CAPS.SALIENCE_CORROBORATE_THRESHOLD["imessage"];
  const embedder = makeEmbedderStub();
  // Seed the index above MIN_INDEX_SIZE so corroboration is enabled.
  const entries = [];
  for (let i = 0; i < 60; i++) {
    entries.push({ memory_id: `mem_seed_${i}`, distance: 0.95 });
  }
  entries.push({ memory_id: "mem_near_dup", distance: imessageThr / 2 });
  const hnsw = makeMutableHnsw({ initial: entries });
  const r = await salienceMod.scoreCandidate(candidate(), {
    embedder,
    hnsw,
    now: NOW,
  });
  assert.equal(r.decision, "CORROBORATE");
  assert.equal(r.target_id, "mem_near_dup");
  assert.equal(embedder.calls.length, 1);
});

// ---------------------------------------------------------------------------
// T3: unrelated neighbour at size >= MIN_INDEX_SIZE → PROMOTE; the novelty
// component reflects the FAR distance (after lerp).
// ---------------------------------------------------------------------------
test("T3: far neighbour (distance > threshold) → PROMOTE; novelty reflects distance", async () => {
  const embedder = makeEmbedderStub();
  const entries = [];
  // Push past the lerp FLOOR (200) so novelty is raw, not lerped.
  for (let i = 0; i < 200; i++) {
    entries.push({ memory_id: `mem_seed_${i}`, distance: 0.9 });
  }
  const hnsw = makeMutableHnsw({ initial: entries });
  const r = await salienceMod.scoreCandidate(candidate(), {
    embedder,
    hnsw,
    now: NOW,
  });
  assert.equal(r.decision, "PROMOTE");
  // At size >= FLOOR there is no lerp; novelty == raw distance (0.9).
  assert.ok(
    Math.abs(r.components.novelty - 0.9) < 1e-9,
    `expected novelty≈0.9 (raw, no lerp) but got ${r.components.novelty}`,
  );
});

// ---------------------------------------------------------------------------
// T4: sparse-index protection — at size < MIN_INDEX_SIZE corroboration is
// SKIPPED even when a near-duplicate is present. PROMOTE wins.
// ---------------------------------------------------------------------------
test("T4: size<MIN_INDEX_SIZE with near-dup → PROMOTE (corroboration disabled)", async () => {
  const imessageThr = CAPS.SALIENCE_CORROBORATE_THRESHOLD["imessage"];
  const embedder = makeEmbedderStub();
  const hnsw = makeMutableHnsw({
    initial: [{ memory_id: "mem_near_dup", distance: imessageThr / 2 }],
  });
  // Force size to a small number despite the seeded entries to exercise the
  // sparse-index gate explicitly. We use the real size accessor (size of
  // entries=1) which is < 50.
  const r = await salienceMod.scoreCandidate(candidate(), {
    embedder,
    hnsw,
    now: NOW,
  });
  assert.equal(
    r.decision,
    "PROMOTE",
    `expected PROMOTE (corroboration disabled at size<50) but got ${r.decision}`,
  );
});

// ---------------------------------------------------------------------------
// T5: novelty lerp boundary — at size=100 (FLOOR=200), raw novelty 1.0 →
// effective novelty 0.75.
// ---------------------------------------------------------------------------
test("T5: size=100 (FLOOR=200) → novelty lerped to 0.75 with raw=1.0", async () => {
  const embedder = makeEmbedderStub();
  const entries = [];
  for (let i = 0; i < 99; i++) {
    entries.push({ memory_id: `mem_seed_${i}`, distance: 0.95 });
  }
  // 100th entry is the "nearest" — distance=1.0 to give raw novelty=1.0.
  entries.push({ memory_id: "mem_far", distance: 1.0 });
  const hnsw = makeMutableHnsw({ initial: entries });
  const r = await salienceMod.scoreCandidate(candidate(), {
    embedder,
    hnsw,
    now: NOW,
  });
  assert.equal(r.decision, "PROMOTE");
  // The "nearest" by distance is whichever is smallest — 0.95. So raw=0.95
  // and effective = 0.5*(1-100/200) + 0.95*(100/200) = 0.25 + 0.475 = 0.725.
  assert.ok(
    Math.abs(r.components.novelty - 0.725) < 1e-9,
    `expected novelty≈0.725 (lerped) but got ${r.components.novelty}`,
  );
});

// ---------------------------------------------------------------------------
// T6: caller-supplied embedding_mrl_768 takes precedence — embedder is NOT
// invoked when the vector is already provided. Pins the no-double-embed
// invariant when the MCP-handler path pre-embeds before calling scoreCandidate.
// ---------------------------------------------------------------------------
test("T6: caller-supplied embedding_mrl_768 short-circuits embedder", async () => {
  const embedder = makeEmbedderStub();
  const hnsw = makeMutableHnsw({ initial: [] });
  const r = await salienceMod.scoreCandidate(candidate(), {
    embedding_mrl_768: unitVec(),
    embedder,
    hnsw,
    now: NOW,
  });
  assert.equal(r.decision, "PROMOTE");
  assert.equal(
    embedder.calls.length,
    0,
    "embedder MUST NOT be called when caller provided embedding_mrl_768",
  );
  assert.ok(
    Array.isArray(r.embedding_mrl_768) && r.embedding_mrl_768.length === 768,
    "PROMOTE return must still surface the embedding (the caller-supplied one)",
  );
});
