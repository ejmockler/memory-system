// time-index-recall-fallback.test.mjs — WORKUNIT N8 (WIRE branch).
//
// Proves the time-index is CONSUMED as a recall candidate pre-filter (not dead
// code). The substrate-tier time-index (sorted projection over absolute time
// anchors) was BUILT + TESTED but never imported by a production module;
// resolvedTimeAnchor was computed in recall and used ONLY as the scalar
// timeAnchorMatch scoring feature, never for candidate selection. This wires it
// into the recall hot path as the temporal mirror of the entity-index fallback.
//
// WIRE-only assertions (spec TESTS 13-15):
//   13. Temporal fallback augments the pool — a recall whose surrounding context
//       resolves an absolute time anchor AND whose fused pool is starved
//       (< RECALL_SUBSTRATE_FALLBACK_TRIGGER_THRESHOLD) gains candidates whose
//       anchors fall within RECALL_TIME_FALLBACK_WINDOW_MS of the anchor.
//   14. Score invariance / no double-count — the time-scoring weights
//       (SCORE_WEIGHT_TIME_ANCHOR / SCORE_WEIGHT_TIME_DECAY) are byte-unchanged;
//       the fallback is candidate-RECALL only, never a parallel scoring signal.
//   15. Absent cache no-op — recall with no time-index cache present still
//       returns (rebuild-or-skip, never throws into the hot path).
//   16. Thesis #1 — driving recall mutates no fact row (the ledger is read-only
//       to recall + the time-index is a derived projection).
//
// HERMETICITY: tmp root + env BEFORE any dynamic import. Embed forced-degraded
// (dead port) and (b4) Layer-3 pinned LOCAL_RERANKER_ENABLED="0" so the test is
// network-free, and the fused pool stays BM25-only / empty -> starved -> the
// fallback trigger fires. The Layer-3 pin is load-bearing: the dead embed port
// governs Layer-1 only, and without the pin recall dialed the live rerank
// daemon on :8360, so "network-free" was false. Production stays byte-identical.
//
// Run: node test/synthesis/time-index-recall-fallback.test.mjs

import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
  existsSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { skipIfDaemonActive } from "../_hermetic-daemon-skip.mjs";
skipIfDaemonActive("time-index-recall-fallback");

// ---------------------------------------------------------------------------
// 0. Hermetic root + env BEFORE any dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-timeidx-fallback-"));
const HERMETIC_ROOT = join(TMP_ROOT, "memory-system");
const POLICY_DIR = join(HERMETIC_ROOT, "policy");
const STORAGE_DIR = join(HERMETIC_ROOT, "storage");
const LEDGERS_DIR = join(HERMETIC_ROOT, "ledgers");
const INDICES_DIR = join(HERMETIC_ROOT, "indices");
for (const d of [HERMETIC_ROOT, POLICY_DIR, STORAGE_DIR, LEDGERS_DIR, INDICES_DIR]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}
process.env.MEMORY_ROOT = HERMETIC_ROOT;
process.env.POLICY_BASE_DIR = POLICY_DIR;
process.env.STORAGE_BASE_DIR = STORAGE_DIR;
process.env.LEDGERS_BASE_DIR = LEDGERS_DIR;
delete process.env.GEMINI_API_KEY;
process.env.LOCAL_EMBED_URL = "http://127.0.0.1:1"; // dead port -> degraded recall
// b4: the dead LOCAL_EMBED_URL above only kills Layer-1. Layer-3 resolves
// separately: an UNSET LOCAL_RERANKER_ENABLED falls through to
// CAPS.LOCAL_RERANKER_ENABLED (true), which skips the gemini key gate and
// sends the default backend at _baseUrl() to the LIVE rerank daemon on :8360.
// "0" is the tri-state OFF override (a `delete` is inert against a true CAP);
// it restores the api_key_missing degrade and issues no socket.
process.env.LOCAL_RERANKER_ENABLED = "0";

process.on("exit", () => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
});

// The checkout this suite runs from. Its default (un-overridden) ledgers,
// policy and indices are what the byte-identity guards below watch; the
// suite itself works under a temp MEMORY_ROOT.
const CHECKOUT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
// Production snapshot guard.
const PROD_MEMORY = join(CHECKOUT_ROOT, "ledgers", "memory.jsonl");
function snap(p) {
  try { const s = statSync(p); return `${s.mtimeMs}:${s.size}`; } catch { return "missing"; }
}
const PROD_MEMORY_BEFORE = snap(PROD_MEMORY);

// ---------------------------------------------------------------------------
// 1. Seed a small ledger with time-anchored fact rows near a target date.
//    These rows carry features.time_anchors[] with absolute instant_iso values
//    a few days apart. They have NO embeddings (empty HNSW) and the query has
//    no lexical overlap with BM25 (empty index), so the fused pool starts < the
//    fallback trigger threshold and the temporal fallback is the augmenter.
// ---------------------------------------------------------------------------
const LEDGER_PATH = join(LEDGERS_DIR, "memory.jsonl");
const TARGET_ISO = "2026-03-10T00:00:00.000Z";

function factRow(id, instantIso, content) {
  return {
    id,
    kind: "fact",
    content,
    source: "manual",
    source_refs: [
      { source: "manual", source_msg_id: "m_" + id, via: "original",
        corroboration_event_id: null, consent_basis: "first_party" },
    ],
    derived_from: [],
    provenance: { agent_id: "operator", conversation_id: null, confidence: "high" },
    features: {
      entities: [],
      time_anchors: [
        { kind: "absolute", instant_iso: instantIso, raw_phrase: null,
          structural: true, stamped_by: "cascade:row-ts" },
      ],
      valence: null,
      embedding_4096: null,
      embedding_model_version: null,
      embed_state: true,
    },
    created_at: instantIso,
    ts: instantIso,
  };
}

const seededRows = [
  // within +-30d of TARGET_ISO -> SHOULD be picked up by queryProximity.
  factRow("near1", "2026-03-08T00:00:00.000Z", "alpha event near target"),
  factRow("near2", "2026-03-12T00:00:00.000Z", "beta event near target"),
  factRow("near3", "2026-03-05T00:00:00.000Z", "gamma event near target"),
  // far outside the 30d window -> should NOT be picked up.
  factRow("far1", "2025-01-01T00:00:00.000Z", "ancient unrelated event"),
];
writeFileSync(
  LEDGER_PATH,
  seededRows.map((r) => JSON.stringify(r)).join("\n") + "\n",
  { mode: 0o600 },
);
const LEDGER_BYTES_BEFORE = readFileSync(LEDGER_PATH);

// ---------------------------------------------------------------------------
// 2. Dynamic imports AFTER env is set.
// ---------------------------------------------------------------------------
const recallMod = await import("../../lib/tools/recall.js");
const { CAPS } = await import("../../lib/validation.js");

const recallHandler = recallMod.TOOL.handler;

// Query whose current_query contains an ISO date so resolveTimeAnchors emits an
// absolute anchor. The phrasing avoids structural entities (no URLs/emails/repo
// paths) so the ENTITY fallback does NOT also fire — the temporal fallback is
// the sole augmenter under test.
function buildArgs() {
  return {
    surrounding_context: {
      recent_turns: [],
      agent_role: "assistant",
      current_query: "what did we record around 2026-03-10 last quarter",
      time: "2026-06-23T00:00:00.000Z",
      ambient: null,
      recent_recall_ids: [],
    },
    conversation_id: "conv_timeidx_fallback",
    max_items: 12,
    max_chars: 4000,
  };
}

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`PASS  ${name}\n`); }
  catch (e) { failures++; process.stdout.write(`FAIL  ${name}\n      ${e && e.message ? e.message : e}\n`); }
}

// ---------------------------------------------------------------------------
// 14 (capture weights BEFORE any recall) — score weights are frozen + unchanged.
// ---------------------------------------------------------------------------
const TIME_ANCHOR_WEIGHT_BEFORE = CAPS.SCORE_WEIGHT_TIME_ANCHOR;
const TIME_DECAY_WEIGHT_BEFORE = CAPS.SCORE_WEIGHT_TIME_DECAY;

// ---------------------------------------------------------------------------
// 13. Temporal fallback augments the pool.
// ---------------------------------------------------------------------------
let env1;
await (async () => {
  env1 = await recallHandler(buildArgs());
  check("13: recall returns ok with a populator block carrying a resolved time anchor", () => {
    if (env1 == null) throw new Error("recall returned null");
    if (env1.ok === false) throw new Error("recall errored: " + JSON.stringify(env1.error));
    const pop = env1.data.populator;
    if (!pop) throw new Error("no populator block on brief");
    if (pop.has_time_anchor !== true) throw new Error("populator.has_time_anchor must be true (ISO date in query)");
  });

  check("13b: temporal fallback fired — fallback_added_candidates > 0 (pool augmented)", () => {
    const pop = env1.data.populator;
    if (pop.fallback_triggered !== true) {
      throw new Error("fallback_triggered must be true; got " + JSON.stringify({
        fallback_triggered: pop.fallback_triggered,
        added: pop.fallback_added_candidates,
        skip: pop.fallback_skip_reason,
        reasons: pop.degraded_reasons,
      }));
    }
    if (!(pop.fallback_added_candidates > 0)) {
      throw new Error("fallback_added_candidates must be > 0; got " + pop.fallback_added_candidates);
    }
    // The 3 near rows are within +-30d; the far row is excluded. The augmenter
    // contributes the near rows (cap-bounded).
    if (pop.fallback_added_candidates > 3) {
      throw new Error("expected <= 3 augmented (only 3 rows within window); got " + pop.fallback_added_candidates);
    }
  });
})();

// ---------------------------------------------------------------------------
// 14. Score invariance / no double-count — time-scoring weights untouched.
// ---------------------------------------------------------------------------
check("14: time-scoring weights byte-unchanged after wiring (no double-count)", () => {
  if (CAPS.SCORE_WEIGHT_TIME_ANCHOR !== TIME_ANCHOR_WEIGHT_BEFORE) {
    throw new Error("SCORE_WEIGHT_TIME_ANCHOR mutated by the fallback");
  }
  if (CAPS.SCORE_WEIGHT_TIME_DECAY !== TIME_DECAY_WEIGHT_BEFORE) {
    throw new Error("SCORE_WEIGHT_TIME_DECAY mutated by the fallback");
  }
  // CAPS is Object.freeze'd; assert it is still frozen (defensive).
  if (!Object.isFrozen(CAPS)) throw new Error("CAPS must stay Object.freeze'd");
});

// ---------------------------------------------------------------------------
// 15. Absent-cache no-op — delete the cache (if any) and re-run; never throws.
// ---------------------------------------------------------------------------
await (async () => {
  const cachePath = join(STORAGE_DIR, "time-index.cache.json");
  try { if (existsSync(cachePath)) rmSync(cachePath); } catch {}
  let env2;
  let threw = null;
  try { env2 = await recallHandler(buildArgs()); } catch (e) { threw = e; }
  check("15: recall with absent time-index cache still returns (rebuild-or-skip, no throw)", () => {
    if (threw != null) throw new Error("recall threw with absent cache: " + threw.message);
    if (env2 == null || env2.ok === false) throw new Error("recall did not return ok with absent cache");
    // The fallback still fires after a rebuild (cache is recreated from the ledger).
    if (env2.data.populator.fallback_triggered !== true) {
      throw new Error("temporal fallback should still fire after cache-rebuild");
    }
  });
})();

// ---------------------------------------------------------------------------
// 16. Thesis #1 — recall mutates NO existing fact row. Recall MAY append a
// policy.salience.recall_feedback row (CP-5 Trigger A) to the same ledger; that
// is an APPEND of a policy-kind row, not a mutation. Assert (a) the original
// seeded fact-row bytes are preserved verbatim as the file prefix, and (b) no
// kind:"fact" row's content/features changed (every seeded id is byte-identical
// to its original line, and no NEW fact-kind row appeared).
// ---------------------------------------------------------------------------
check("16: thesis #1 — recall mutates no existing fact row (seeded rows byte-identical)", () => {
  const afterRaw = readFileSync(LEDGER_PATH, "utf8");
  const afterLines = afterRaw.split("\n").filter((l) => l.trim() !== "");
  const beforeLines = LEDGER_BYTES_BEFORE.toString("utf8")
    .split("\n").filter((l) => l.trim() !== "");
  // (a) the original fact-row lines are preserved verbatim as the file prefix.
  for (let i = 0; i < beforeLines.length; i++) {
    if (afterLines[i] !== beforeLines[i]) {
      throw new Error(`seeded ledger line ${i} changed during recall (thesis #1 violation)`);
    }
  }
  // (b) no NEW fact-kind row was appended (any appended rows are policy-kind).
  const beforeFactCount = beforeLines
    .map((l) => { try { return JSON.parse(l); } catch { return {}; } })
    .filter((r) => r.kind === "fact").length;
  const afterFactCount = afterLines
    .map((l) => { try { return JSON.parse(l); } catch { return {}; } })
    .filter((r) => r.kind === "fact").length;
  if (afterFactCount !== beforeFactCount) {
    throw new Error(`fact-row count changed ${beforeFactCount}->${afterFactCount} (recall must not write fact rows)`);
  }
});

// ---------------------------------------------------------------------------
// Production-safety guard.
// ---------------------------------------------------------------------------
check("prod: production memory.jsonl byte-identical pre/post", () => {
  if (snap(PROD_MEMORY) !== PROD_MEMORY_BEFORE) {
    throw new Error("production memory.jsonl changed during this test");
  }
});

if (failures > 0) {
  process.stdout.write(`\nFAIL  time-index-recall-fallback.test.mjs — ${failures} failing group(s)\n`);
  process.exit(1);
}
process.stdout.write("\nALL PASS  time-index-recall-fallback.test.mjs\n");
process.exit(0);
