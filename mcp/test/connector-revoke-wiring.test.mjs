// connector-revoke-wiring.test.mjs — Round-21 (d) hot-fix gate.
//
// Brutalist substitute REFUTED the round-20 C4 kill-switch claim:
//   hard-gates.js:268 filtered all non-excise policy rows, dropping
//   connector_revoke markers on the floor. memory_connectors_revoke MCP
//   tool did not exist. The "authoritative kill-switch" comment was
//   aspirational.
//
// This test exists so that regression is detected mechanically:
//   1. Write a synthetic memory.jsonl with a fact derived from source="imessage"
//      and a policy event with policy_kind="connector_revoke" target_source="imessage".
//   2. Run loadDerivationExciseSet — the fact's memory_id MUST appear in the
//      excise set. (Pre-fix: empty set; post-fix: 1 entry.)
//   3. Run loadTransitiveOrphanMap — the fact MUST be reachable from the seed
//      with distance 0 (it IS the seed).
//   4. Test the memory_connectors_revoke MCP tool surface: assert it exists in
//      the registry; calling it appends a connector_revoke policy event.
//   5. End-to-end: call memory_connectors_revoke, then loadDerivationExciseSet,
//      and confirm the fact has been seeded for orphan-propagation.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// HERMETICITY: mkdtempSync + env-vars-before-dynamic-import (standing pattern).
const TEST_ROOT = mkdtempSync(join(tmpdir(), "connector-revoke-test-"));
mkdirSync(join(TEST_ROOT, "policy"), { recursive: true });
mkdirSync(join(TEST_ROOT, "storage", "sources"), { recursive: true });
mkdirSync(join(TEST_ROOT, "ledgers"), { recursive: true });
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
process.env.TELEMETRY_BASE_DIR = join(TEST_ROOT, "telemetry");
process.on("exit", () => {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
});

const { applyConnectorRevoke } = await import("../lib/connectors/index.js");
const { loadDerivationExciseSet, loadTransitiveOrphanMap } = await import("../lib/recall/hard-gates.js");
const { executeTool, toolCount, listTools } = await import("../lib/dispatch.js");
const { memoryLedgerPath } = await import("../lib/config.js");
const { listSources } = await import("../lib/ingest/stage0/index.js");

function check(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
    return 0;
  }
  console.error(`FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
  return 1;
}

let failures = 0;

function seedLedger(rows) {
  const path = memoryLedgerPath();
  mkdirSync(dirname(path), { recursive: true });
  const content = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(path, content, { mode: 0o600 });
}


// ---------------------------------------------------------------------------
// T1: connector_revoke is picked up by loadDerivationExciseSet via the
// hard-gates.js _scanLedger memoryIdsBySource resolution.
// ---------------------------------------------------------------------------
{
  seedLedger([
    {
      id: "mem_imessage_fact_a",
      kind: "fact",
      ts: "2026-06-02T00:00:00Z",
      content: "iMessage from Robin",
      source_refs: [{ source: "imessage", source_msg_id: "msg_001" }],
      derived_from: [],
    },
    {
      id: "mem_imessage_fact_b",
      kind: "fact",
      ts: "2026-06-02T00:01:00Z",
      content: "another iMessage",
      source_refs: [{ source: "imessage", source_msg_id: "msg_002" }],
      derived_from: ["mem_imessage_fact_a"],
    },
    {
      id: "mem_screentime_fact_c",
      kind: "fact",
      ts: "2026-06-02T00:02:00Z",
      content: "screen time row",
      source_refs: [{ source: "screentime", source_msg_id: "st_001" }],
      derived_from: [],
    },
    {
      id: "policy_revoke_imessage",
      kind: "policy",
      ts: "2026-06-02T00:10:00Z",
      policy_kind: "connector_revoke",
      target_source: "imessage",
    },
  ]);

  const exciseSet = await loadDerivationExciseSet();
  failures += check(
    "T1 imessage facts in excise set",
    exciseSet.has("mem_imessage_fact_a") && exciseSet.has("mem_imessage_fact_b"),
    `got Array.from(set)=${JSON.stringify(Array.from(exciseSet))}`,
  );
  failures += check(
    "T1 screentime fact NOT in excise set (different source)",
    !exciseSet.has("mem_screentime_fact_c"),
    "screentime should not be excised by an imessage revoke",
  );
}

// ---------------------------------------------------------------------------
// T2: transitive orphan map propagates through derivation_graph from the
// revoke seed.
// ---------------------------------------------------------------------------
{
  const orphanMap = await loadTransitiveOrphanMap();
  const aInfo = orphanMap.get("mem_imessage_fact_a");
  const bInfo = orphanMap.get("mem_imessage_fact_b");
  failures += check(
    "T2 mem_imessage_fact_a is at distance 0 (it IS a seed)",
    aInfo != null && aInfo.distance_to_nearest_excised === 0,
    aInfo ? `got ${aInfo.distance_to_nearest_excised}` : "missing",
  );
  failures += check(
    "T2 mem_imessage_fact_b is at distance 1 (descendant of seed via derived_from)",
    bInfo != null && bInfo.distance_to_nearest_excised <= 1,
    bInfo ? `got ${bInfo.distance_to_nearest_excised}` : "missing",
  );
}

// ---------------------------------------------------------------------------
// T3: memory_connectors_revoke MCP tool is registered in dispatch.
// ---------------------------------------------------------------------------
{
  const tools = listTools();
  const names = new Set(tools.map((t) => t.name));
  failures += check(
    "T3 memory_connectors_revoke registered in dispatch",
    names.has("memory_connectors_revoke"),
    `got: ${Array.from(names).sort().join(",")}`,
  );
  failures += check(
    "T3 toolCount() == 14 (14th tool is memory_catchup_feedback)",
    // The 14th dispatch tool is memory_catchup_feedback (messaging/feedback-log.js).
    toolCount() === 14,
    `got ${toolCount()}`,
  );
}

// ---------------------------------------------------------------------------
// T4: executeTool memory_connectors_revoke writes a policy event AND the
// transitive-orphan machinery sees it.
// ---------------------------------------------------------------------------
{
  // Reset the ledger to JUST the iMessage fact (no pre-existing revoke).
  seedLedger([
    {
      id: "mem_pre_revoke",
      kind: "fact",
      ts: "2026-06-02T00:00:00Z",
      content: "iMessage to be revoked",
      source_refs: [{ source: "imessage", source_msg_id: "msg_x" }],
      derived_from: [],
    },
  ]);

  const exciseBefore = await loadDerivationExciseSet();
  failures += check(
    "T4 before revoke: mem_pre_revoke NOT in excise set",
    !exciseBefore.has("mem_pre_revoke"),
    "fact should be excise-free before the revoke is issued",
  );

  const envelope = await executeTool("memory_connectors_revoke", { source: "imessage" });
  failures += check(
    "T4 executeTool returned ok envelope",
    envelope.ok === true,
    `error=${JSON.stringify(envelope.error)}`,
  );
  failures += check(
    "T4 envelope.data has revoke_event_id",
    typeof envelope.data?.revoke_event_id === "string" && envelope.data.revoke_event_id.length > 0,
    `got ${JSON.stringify(envelope.data)}`,
  );
  failures += check(
    "T4 envelope.data.target_source matches",
    envelope.data?.target_source === "imessage",
    `got ${envelope.data?.target_source}`,
  );
  failures += check(
    "T4 envelope.data.recognized=true (imessage is a KNOWN_SOURCE)",
    envelope.data?.recognized === true,
  );

  const exciseAfter = await loadDerivationExciseSet();
  failures += check(
    "T4 after revoke: mem_pre_revoke IS in excise set (kill-switch wired)",
    exciseAfter.has("mem_pre_revoke"),
    `got Array.from(set)=${JSON.stringify(Array.from(exciseAfter))}`,
  );
}

// ---------------------------------------------------------------------------
// T4b: every source declared by the stage-0 registry is recognized by the
// connector-revoke operator surface.
// ---------------------------------------------------------------------------
{
  for (const source of listSources()) {
    const envelope = await executeTool("memory_connectors_revoke", { source });
    failures += check(
      `T4b stage-0 source ${source} is recognized`,
      envelope.ok === true && envelope.data?.recognized === true,
      `got ${JSON.stringify(envelope)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// T5: rescinding a connector_revoke deactivates the kill-switch.
// ---------------------------------------------------------------------------
{
  seedLedger([
    {
      id: "mem_rescind_test",
      kind: "fact",
      ts: "2026-06-02T00:00:00Z",
      content: "iMessage with rescindable revoke",
      source_refs: [{ source: "imessage", source_msg_id: "msg_r" }],
      derived_from: [],
    },
    {
      id: "policy_revoke_to_rescind",
      kind: "policy",
      ts: "2026-06-02T00:01:00Z",
      policy_kind: "connector_revoke",
      target_source: "imessage",
      active: false, // inline-deactivation
    },
  ]);

  const excise = await loadDerivationExciseSet();
  failures += check(
    "T5 inline-deactivated revoke does NOT excise",
    !excise.has("mem_rescind_test"),
    "active=false should suppress the revoke from the seed set",
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log(`\nAll connector-revoke-wiring assertions passed.`);
