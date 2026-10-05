// cold-start-novelty.test.mjs — R25.5 CRIT-6 regression battery.
//
// Pins the cold-start novelty lerp + corroboration disable behaviour added to
// mcp/lib/ingest/salience.js. Without these guards, alphabetical phase
// ordering during Phase D backfill would admit ~130k git-log rows at
// novelty=1.0 first (empty index → raw novelty=1.0); ~80k rows later iMessage
// rows paraphrasing the same topics would collapse to corroboration against
// the inflated git-log facts and destroy iMessage provenance. The fix:
//
//   1. effective_novelty lerps from 0.5 toward raw while hnsw.size() <
//      CAPS.SALIENCE_NOVELTY_LERP_FLOOR (default 200).
//   2. corroboration branch is skipped while hnsw.size() <
//      CAPS.SALIENCE_CORROBORATE_MIN_INDEX_SIZE (default 50).
//
// HERMETIC: synthetic stub HNSW, no I/O beyond a tmp MEMORY_ROOT.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-cold-start-novelty-"));
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

// Bypass Stage-0 dispatch so each test exercises Layer 2/3 directly.
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

// stubHnsw lets us decouple "size()" from "search()" so we can synthesize
// any cold-start point without populating real vectors.
function stubHnsw({ size, neighbours = [] }) {
  return {
    size: () => size,
    search: () =>
      neighbours.map((n, i) => ({
        memory_id: n.memory_id,
        cosine_distance: n.distance,
        rank: i,
      })),
  };
}

// Synthetic PROMOTE candidate. Stage-0 returns PASS (bypassed above) and
// Layer-2 components are deterministic; only the kNN branch varies.
function candidate() {
  return {
    source: "imessage",
    source_msg_id: "imsg_cold_start",
    content:
      "Cold-start novelty regression: a substantive sentence so contentMassScore is non-zero and we exercise the salience path.",
    consent_basis: "first_party",
    ts: "2026-06-01T00:00:00Z",
    raw_content: {
      text: "Cold-start novelty regression: a substantive sentence so contentMassScore is non-zero and we exercise the salience path.",
      handle_id: "+15555550100",
    },
  };
}

// ---------------------------------------------------------------------------
// T1: empty index → raw novelty would be 1.0 but effective is 0.5 (full lerp).
// ---------------------------------------------------------------------------
test("T1: hnsw.size()=0 → effective_novelty == 0.5 (raw 1.0 fully suppressed)", async () => {
  const r = await salienceMod.scoreCandidate(candidate(), {
    embedding_mrl_768: unitVec(),
    hnsw: stubHnsw({ size: 0, neighbours: [] }),
    now: NOW,
  });
  assert.equal(r.decision, "PROMOTE");
  assert.equal(
    r.components.novelty,
    0.5,
    `expected novelty=0.5 at empty index but got ${r.components.novelty}`,
  );
});

// ---------------------------------------------------------------------------
// T2: midway → effective = 0.5*(1 - t) + raw*t where t = size/FLOOR.
// At size=100, FLOOR=200, raw=1.0 (nearest cosine_distance=1.0): t=0.5,
// effective = 0.5*0.5 + 1.0*0.5 = 0.75. We use a FAR neighbour (distance=1.0)
// so corroboration cannot fire and we can read the lerp output cleanly.
// ---------------------------------------------------------------------------
test("T2: hnsw.size()=100 (FLOOR=200) → effective_novelty == 0.75 (midway lerp)", async () => {
  assert.equal(
    CAPS.SALIENCE_NOVELTY_LERP_FLOOR,
    200,
    "test arithmetic assumes FLOOR=200",
  );
  const r = await salienceMod.scoreCandidate(candidate(), {
    embedding_mrl_768: unitVec(),
    hnsw: stubHnsw({
      size: 100,
      neighbours: [
        { memory_id: "mem_far", distance: 1.0 }, // raw novelty = 1.0
      ],
    }),
    now: NOW,
  });
  assert.equal(r.decision, "PROMOTE");
  // 0.5 * (1 - 100/200) + 1.0 * (100/200) = 0.25 + 0.5 = 0.75
  assert.ok(
    Math.abs(r.components.novelty - 0.75) < 1e-9,
    `expected novelty≈0.75 but got ${r.components.novelty}`,
  );
});

// ---------------------------------------------------------------------------
// T3: at hnsw.size() >= FLOOR → no lerp; effective_novelty == raw_novelty.
// ---------------------------------------------------------------------------
test("T3: hnsw.size()=200 (== FLOOR) → effective_novelty == raw (no lerp)", async () => {
  const r = await salienceMod.scoreCandidate(candidate(), {
    embedding_mrl_768: unitVec(),
    hnsw: stubHnsw({
      size: 200,
      neighbours: [
        { memory_id: "mem_far", distance: 0.9 }, // raw novelty = 0.9
      ],
    }),
    now: NOW,
  });
  assert.equal(r.decision, "PROMOTE");
  assert.ok(
    Math.abs(r.components.novelty - 0.9) < 1e-9,
    `expected novelty≈0.9 (raw, no lerp) but got ${r.components.novelty}`,
  );
});

// ---------------------------------------------------------------------------
// T4: at hnsw.size() < CORROBORATE_MIN_INDEX_SIZE → corroboration is skipped.
// We construct a near-duplicate (distance well under the iMessage threshold
// of 0.18) so WITHOUT the guard the decision would be CORROBORATE. With the
// guard the decision MUST be PROMOTE.
// ---------------------------------------------------------------------------
test("T4: hnsw.size()<50 with near-dup neighbour → PROMOTE (corroboration disabled)", async () => {
  assert.equal(
    CAPS.SALIENCE_CORROBORATE_MIN_INDEX_SIZE,
    50,
    "test arithmetic assumes MIN_INDEX_SIZE=50",
  );
  const imessageThr = CAPS.SALIENCE_CORROBORATE_THRESHOLD["imessage"];
  assert.ok(typeof imessageThr === "number" && imessageThr > 0);
  const r = await salienceMod.scoreCandidate(candidate(), {
    embedding_mrl_768: unitVec(),
    hnsw: stubHnsw({
      size: 10,
      neighbours: [
        { memory_id: "mem_near_dup", distance: imessageThr / 2 },
      ],
    }),
    now: NOW,
  });
  assert.equal(
    r.decision,
    "PROMOTE",
    `expected PROMOTE (corroboration disabled at size<50) but got ${r.decision}`,
  );
});

// ---------------------------------------------------------------------------
// T4b (additional confidence): at hnsw.size() >= 50 the near-dup neighbour
// MUST trigger CORROBORATE. Pins both halves of the gate.
// ---------------------------------------------------------------------------
test("T4b: hnsw.size()>=50 with near-dup neighbour → CORROBORATE (gate re-enabled)", async () => {
  const imessageThr = CAPS.SALIENCE_CORROBORATE_THRESHOLD["imessage"];
  const r = await salienceMod.scoreCandidate(candidate(), {
    embedding_mrl_768: unitVec(),
    hnsw: stubHnsw({
      size: 50,
      neighbours: [
        { memory_id: "mem_near_dup", distance: imessageThr / 2 },
      ],
    }),
    now: NOW,
  });
  assert.equal(r.decision, "CORROBORATE");
});
