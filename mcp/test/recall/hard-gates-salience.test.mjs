// hard-gates-salience.test.mjs — R25.5 CRIT-2 + CRIT-3 regression gates.
//
// AUTHORITATIVE spec source:
//   kb/salience-design.md § CP-3 Corroboration
//   retroactivity on connector_revoke (stale_post_revoke surfaces drift)
//   mcp/lib/recall/hard-gates.js header (sidecar
//   schema RETROACTIVE_DROP_SIDECAR_VERSION + emission rules)
//   mcp/scripts/replay-stage0.mjs header (producer
//   side of the sidecar schema)
//
// What this test guards
// ---------------------
// The R25 bundle landed three interlocking bugs that hid each other:
//   CRIT-2: policy.salience.stale_post_revoke declared but never emitted.
//   CRIT-3: hard-gates blind to retroactive_drop sidecars (replay-stage0
//           wrote them, recall never read them).
//   sidecar path/schema drift between producer (replay-stage0) and
//           consumer (hard-gates).
// Each bug must fail INDEPENDENTLY — the recurrence story for R25 was that
// each bug masked the other. The three tests below are constructed so the
// failure of any one of the three closes does not silently mask the others.
//
// Hermeticity (standing C-NEW-2 pattern): mkdtempSync paths + env-vars set
// BEFORE dynamic import of memory-system modules. No production fs writes.
//
// Test inventory:
//   T1 — sidecar retroactive_drop is folded into the excise set + orphan
//        map (CRIT-3 close; would fail before hard-gates read the sidecar).
//   T2 — connector_revoke BFS over a salience-scored fact emits ONE
//        policy.salience.stale_post_revoke event with the spec'd shape
//        (CRIT-2 close; would fail when the emitter is missing or the
//        salienceFacts capture is missing).
//   T3 — facts that are corroboration SOURCES of a revoked source are
//        NOT in the excise set; only the rows whose own source_refs[].source
//        is revoked fold. Belt-and-suspenders against an over-eager
//        retroactivity rule.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Hermeticity: stake tmp dirs and overwrite env BEFORE dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-hard-gates-salience-test-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
const POLICY_DIR = join(MEMORY_ROOT, "policy");
const STORAGE_DIR = join(MEMORY_ROOT, "storage");
const LEDGERS_DIR = join(MEMORY_ROOT, "ledgers");
const SIDECAR_DIR = join(STORAGE_DIR, "salience-sidecars");
mkdirSync(POLICY_DIR, { recursive: true });
mkdirSync(STORAGE_DIR, { recursive: true });
mkdirSync(LEDGERS_DIR, { recursive: true });
mkdirSync(SIDECAR_DIR, { recursive: true });

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

// Dynamic import AFTER env override.
const {
  loadDerivationExciseSet,
  loadTransitiveOrphanMap,
  _resetTransitiveOrphanCaches,
  RETROACTIVE_DROP_SIDECAR_VERSION,
  retroactiveDropSidecarDir,
} = await import("../../lib/recall/hard-gates.js");
const { memoryLedgerPath } = await import("../../lib/config.js");

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Per-test setup helpers.
// ---------------------------------------------------------------------------
function seedLedger(rows) {
  const path = memoryLedgerPath();
  const content = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(path, content, { mode: 0o600 });
  // Cache busts on mtime/size — but tests can fire faster than mtime
  // resolution. Explicit reset is the safe path.
  _resetTransitiveOrphanCaches();
}

function writeSidecar(filename, rows) {
  const path = join(SIDECAR_DIR, filename);
  const content = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(path, content, { mode: 0o600 });
  _resetTransitiveOrphanCaches();
}

function clearSidecars() {
  if (!existsSync(SIDECAR_DIR)) return;
  for (const name of readdirSync(SIDECAR_DIR)) {
    try {
      rmSync(join(SIDECAR_DIR, name));
    } catch {
      // best-effort
    }
  }
  _resetTransitiveOrphanCaches();
}

// Local cache buster — we want to bust the orphan-map cache (so the BFS
// re-runs) but KEEP the _emittedStaleByKey set (so the dedup check works).
// _resetTransitiveOrphanCaches clears both, so we bypass it for the dedup
// part of T2. We achieve a "graph cache only" bust by rewriting the ledger
// file to bump mtime (the cache key combines mtime + size + sidecar
// fingerprint; size and sidecars unchanged but mtime advances).
function _orphanCacheBust() {
  const path = memoryLedgerPath();
  const body = readFileSync(path, "utf8");
  writeFileSync(path, body, { mode: 0o600 });
}

function readPolicyEvents() {
  if (!existsSync(POLICY_DIR)) return [];
  const out = [];
  for (const name of readdirSync(POLICY_DIR)) {
    if (!name.startsWith("policy-events-") || !name.endsWith(".jsonl")) continue;
    const raw = readFileSync(join(POLICY_DIR, name), "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (t === "") continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        // skip malformed
      }
    }
  }
  return out;
}

// Confirm the sidecar-dir helper is the directory we're writing to. If this
// fails, the entire sidecar wiring test is meaningless — that's WHY the
// regression test exists. The producer (replay-stage0) and consumer
// (hard-gates) MUST agree.
check(
  "sidecar dir helper matches the producer-side STORAGE_DIR/salience-sidecars/",
  retroactiveDropSidecarDir() === SIDECAR_DIR,
  `helper returned ${retroactiveDropSidecarDir()}; test seeds at ${SIDECAR_DIR}`,
);

// ---------------------------------------------------------------------------
// T1 — sidecar retroactive_drop is folded into the excise set + orphan map.
// ---------------------------------------------------------------------------
// CRIT-3 wiring test. Fails BEFORE the fix because _scanLedger never glob'd
// the sidecar directory. The connector-revoke and direct-excise paths are
// SEPARATELY exercised here so a missing sidecar wiring cannot be masked
// by either of them.
{
  clearSidecars();
  seedLedger([
    {
      id: "mem_T1_fact_a",
      kind: "fact",
      ts: "2026-06-02T00:00:00Z",
      content: "from imessage; will be retroactively dropped",
      source_refs: [{ source: "imessage", source_msg_id: "msg_T1_a" }],
      derived_from: [],
    },
    {
      id: "mem_T1_fact_b",
      kind: "fact",
      ts: "2026-06-02T00:01:00Z",
      content: "derived from fact_a",
      source_refs: [{ source: "imessage", source_msg_id: "msg_T1_b" }],
      derived_from: ["mem_T1_fact_a"],
    },
    {
      id: "mem_T1_unrelated",
      kind: "fact",
      ts: "2026-06-02T00:02:00Z",
      content: "unrelated; should remain",
      source_refs: [{ source: "screentime", source_msg_id: "st_T1_x" }],
      derived_from: [],
    },
  ]);

  writeSidecar("retroactive-drop-test-T1.jsonl", [
    {
      dropped_at_ts: "2026-06-02T01:00:00Z",
      target_memory_id: "mem_T1_fact_a",
      reason: "stage0_imessage_tapback_tightened",
      replay_run_id: "test-T1",
      version: RETROACTIVE_DROP_SIDECAR_VERSION,
    },
  ]);

  const exciseSet = await loadDerivationExciseSet();
  check(
    "T1 retroactive_drop sidecar -> excise set contains target_memory_id",
    exciseSet.has("mem_T1_fact_a"),
    `got Array.from(set)=${JSON.stringify(Array.from(exciseSet))}`,
  );
  check(
    "T1 retroactive_drop sidecar does NOT excise the unrelated screentime fact",
    !exciseSet.has("mem_T1_unrelated"),
    "sidecar should only touch target_memory_ids it names",
  );

  const orphanMap = await loadTransitiveOrphanMap();
  const aInfo = orphanMap.get("mem_T1_fact_a");
  const bInfo = orphanMap.get("mem_T1_fact_b");
  check(
    "T1 retroactive_drop seed is in orphan map at distance 0",
    aInfo != null && aInfo.distance_to_nearest_excised === 0,
    aInfo ? `got d=${aInfo.distance_to_nearest_excised}` : "missing",
  );
  check(
    "T1 descendant of retroactive_drop seed is orphan at distance 1",
    bInfo != null && bInfo.distance_to_nearest_excised === 1,
    bInfo ? `got d=${bInfo.distance_to_nearest_excised}` : "missing",
  );

  // Version-gating regression: a sidecar row with the WRONG schema version
  // must NOT excise anything. Belt-and-suspenders against a future bump.
  writeSidecar("retroactive-drop-test-T1b.jsonl", [
    {
      dropped_at_ts: "2026-06-02T02:00:00Z",
      target_memory_id: "mem_T1_unrelated",
      reason: "future_schema",
      replay_run_id: "test-T1b",
      version: 99,
    },
  ]);
  const exciseSet2 = await loadDerivationExciseSet();
  check(
    "T1 sidecar with unknown version is rejected (version gate)",
    !exciseSet2.has("mem_T1_unrelated"),
    `unrelated should NOT be excised; got=${JSON.stringify(Array.from(exciseSet2))}`,
  );
  clearSidecars();
}

// ---------------------------------------------------------------------------
// T2 — connector_revoke BFS over a salience-scored fact emits exactly one
// policy.salience.stale_post_revoke event with the spec'd shape.
// ---------------------------------------------------------------------------
// CRIT-2 wiring test. Fails BEFORE the fix because _scanLedger never tracked
// features.salience and the BFS never called appendPolicyEvent. Idempotency
// is verified by calling loadTransitiveOrphanMap twice in this process and
// confirming exactly ONE emission per fact (not two).
{
  _resetTransitiveOrphanCaches();
  const beforeEmits = readPolicyEvents().length;

  seedLedger([
    {
      id: "mem_T2_salience_fact",
      kind: "fact",
      ts: "2026-06-02T00:00:00Z",
      content: "salience-scored fact derived from imessage",
      source_refs: [{ source: "imessage", source_msg_id: "msg_T2_a" }],
      derived_from: [],
      features: {
        salience: {
          score: 0.72,
          components: { novelty: 0.91, authorship: 0.5, structural: 0.6 },
          weights_hash: "SALIENCE_WEIGHTS_V1_HASH_TEST",
          version: 1,
        },
      },
    },
    {
      id: "mem_T2_descendant_salience",
      kind: "fact",
      ts: "2026-06-02T00:01:00Z",
      content: "descendant; also salience-scored",
      source_refs: [{ source: "imessage", source_msg_id: "msg_T2_b" }],
      derived_from: ["mem_T2_salience_fact"],
      features: {
        salience: {
          score: 0.61,
          components: { novelty: 0.82, authorship: 0.4, structural: 0.5 },
          weights_hash: "SALIENCE_WEIGHTS_V1_HASH_TEST",
          version: 1,
        },
      },
    },
    {
      id: "mem_T2_no_salience",
      kind: "fact",
      ts: "2026-06-02T00:02:00Z",
      content: "no features.salience; should NOT trigger stale_post_revoke",
      source_refs: [{ source: "imessage", source_msg_id: "msg_T2_c" }],
      derived_from: [],
    },
    {
      id: "policy_T2_revoke",
      kind: "policy",
      ts: "2026-06-02T00:10:00Z",
      policy_kind: "connector_revoke",
      target_source: "imessage",
    },
  ]);

  // First BFS: should emit stale_post_revoke for the two salience-scored facts.
  await loadTransitiveOrphanMap();
  const after1 = readPolicyEvents();
  const stale1 = after1.filter(
    (e) => e.kind === "policy.salience.stale_post_revoke",
  );
  check(
    "T2 first BFS emits exactly 2 stale_post_revoke (one per salience fact)",
    stale1.length === 2,
    `got ${stale1.length}; events=${JSON.stringify(stale1.map((e) => e.fact_id))}`,
  );

  if (stale1.length >= 1) {
    const e = stale1.find((x) => x.fact_id === "mem_T2_salience_fact");
    check(
      "T2 stale event has fact_id == seed memory_id",
      e != null,
      "expected event for mem_T2_salience_fact",
    );
    check(
      "T2 stale event has target_source == 'imessage'",
      e != null && e.target_source === "imessage",
      e ? `got ${e.target_source}` : "missing event",
    );
    check(
      "T2 stale event has revoke_event_id == 'policy_T2_revoke'",
      e != null && e.revoke_event_id === "policy_T2_revoke",
      e ? `got ${e.revoke_event_id}` : "missing event",
    );
    check(
      "T2 stale event records novelty_component_was",
      e != null && typeof e.novelty_component_was === "number" && e.novelty_component_was === 0.91,
      e ? `got ${e.novelty_component_was}` : "missing event",
    );
    check(
      "T2 stale event has discovered_at ISO timestamp",
      e != null && typeof e.discovered_at === "string" && e.discovered_at.endsWith("Z"),
      e ? `got ${e.discovered_at}` : "missing event",
    );
  }

  // The non-salience fact should NOT have an event.
  const eNoSal = stale1.find((x) => x.fact_id === "mem_T2_no_salience");
  check(
    "T2 fact without features.salience does NOT trigger stale_post_revoke",
    eNoSal == null,
    "non-salience-scored facts have no drift surface",
  );

  // Second BFS: idempotency. The process-scope dedup set should suppress
  // re-emission.
  _orphanCacheBust(); // bust the orphan-map cache but NOT the dedup set
  await loadTransitiveOrphanMap();
  const after2 = readPolicyEvents();
  const stale2 = after2.filter(
    (e) => e.kind === "policy.salience.stale_post_revoke",
  );
  check(
    "T2 second BFS does NOT re-emit (idempotency by fact_id|revoke_event_id)",
    stale2.length === stale1.length,
    `got ${stale2.length}; expected ${stale1.length}`,
  );

  // Drift surface: pre-test count was beforeEmits; post-second-BFS is
  // beforeEmits + stale1.length (no rescue events, no other audit traffic).
  check(
    "T2 only stale_post_revoke events were emitted by the BFS",
    after2.length === beforeEmits + stale1.length,
    `delta=${after2.length - beforeEmits}, stale=${stale1.length}`,
  );
}

// ---------------------------------------------------------------------------
// T3 — facts that are corroboration SOURCES of a revoked source are NOT in
// the excise set. Only the row whose OWN source_refs[].source is revoked
// folds. This protects against an over-eager retroactivity rule that would
// otherwise collapse cross-source provenance.
// ---------------------------------------------------------------------------
// The setup: fact_A from screentime is referenced as a corroboration source
// FROM fact_B (which has imessage source). connector_revoke on imessage
// should excise fact_B (direct match) but NOT fact_A (the cross-source
// corroboration target).
{
  _resetTransitiveOrphanCaches();
  seedLedger([
    {
      id: "mem_T3_screentime_origin",
      kind: "fact",
      ts: "2026-06-02T00:00:00Z",
      content: "screentime-derived fact; will be cited as a corroboration source",
      source_refs: [{ source: "screentime", source_msg_id: "st_T3" }],
      derived_from: [],
    },
    {
      id: "mem_T3_imessage_fact",
      kind: "fact",
      ts: "2026-06-02T00:01:00Z",
      content: "imessage-derived fact; will be revoked",
      source_refs: [{ source: "imessage", source_msg_id: "msg_T3" }],
      derived_from: [],
    },
    {
      id: "policy_T3_corroboration",
      kind: "policy",
      ts: "2026-06-02T00:02:00Z",
      policy_kind: "corroboration",
      targets: ["mem_T3_imessage_fact"],
      payload: {
        source_ref: {
          source: "screentime",
          source_msg_id: "st_T3",
          target_memory_id: "mem_T3_screentime_origin",
        },
      },
    },
    {
      id: "policy_T3_revoke",
      kind: "policy",
      ts: "2026-06-02T00:03:00Z",
      policy_kind: "connector_revoke",
      target_source: "imessage",
    },
  ]);

  const excise = await loadDerivationExciseSet();
  check(
    "T3 imessage fact IS in excise set (direct source-match revoke)",
    excise.has("mem_T3_imessage_fact"),
    `got Array.from(set)=${JSON.stringify(Array.from(excise))}`,
  );
  check(
    "T3 screentime corroboration SOURCE is NOT in excise set",
    !excise.has("mem_T3_screentime_origin"),
    "cross-source provenance must not collapse on the cited source's revoke",
  );

  const orphanMap = await loadTransitiveOrphanMap();
  const sInfo = orphanMap.get("mem_T3_screentime_origin");
  check(
    "T3 screentime corroboration SOURCE is NOT in orphan map",
    sInfo == null,
    `expected absent; got ${JSON.stringify(sInfo)}`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
} else {
  console.log("\nall hard-gates-salience tests passed");
}
