// get.test.mjs — F1 — memory_get ledger-backed read.
//
// Proves the named properties from the F1 spec (>=12 assertion groups):
//   1.  Registration — toolCount()===14; listTools has memory_get with a
//       strict (additionalProperties:false) schema.
//   2.  Fact row parity — a mail-shaped fact returns its real content,
//       source, ts, confidence, agent_id, parties, direction, authored_by,
//       source_refs[0].source_msg_id / via, embedding_model_version,
//       created_at, superseded_by.
//   3.  No vector leak — serialized data lacks "embedding_4096" and
//       "checksum"; under 20 KB.
//   4.  Cross-tool parity — __resolveProvenanceAttribution(fixture) deep-equals
//       the six attribution keys on data.provenance.
//   5.  Reconstructed row — kind, derived_from, source_refs[0].event_id, content.
//   6.  Policy row — kind, content "", derived_from [], rescinded_at null.
//   7.  Unknown id → NOT_FOUND.
//   8.  Prefix routing is dead — "missing_x" → NOT_FOUND because absent; an
//       appended "policy_real" fact row is returned as kind "fact" (tail-merge).
//   9.  {id:null} and {id:"x", extra:1} → INVALID_ARGUMENTS.
//   10. Missing ledger → NOT_FOUND, never INTERNAL_ERROR.
//   11. derived_into — get(a) ["rec_f1test02"], get(b) [] (graph loaded,
//       cold-built from the fixture); conversation_id is the row value; the
//       fixture ledger bytes are unchanged; no conversation-index import.
//   12. Export parity for F3 — projectSourceRefs / projectMemoryEvent.
//
// HERMETICITY: env vars set BEFORE the dynamic import of dispatch.js. All
// disk writes redirect into mkdtempSync. Production memory.jsonl MUST NOT
// change across this run (mtime/size snapshot; exit 2 on change).
//
// Run: node test/tools/get.test.mjs   (exits 0 on pass, non-zero on failure)

import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Hermetic root setup — MUST happen before any dynamic import.
// ---------------------------------------------------------------------------
const TEST_ROOT = mkdtempSync(join(tmpdir(), "memsys-get-test-"));
mkdirSync(join(TEST_ROOT, "policy"), { recursive: true });
mkdirSync(join(TEST_ROOT, "ledgers"), { recursive: true });
mkdirSync(join(TEST_ROOT, "storage", "sources"), { recursive: true });
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
process.env.TELEMETRY_BASE_DIR = join(TEST_ROOT, "telemetry");
process.on("exit", () => {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
});

const LEDGER_PATH = join(TEST_ROOT, "ledgers", "memory.jsonl");

// Production-safety pre-snapshot: capture mtime+size of the real memory.jsonl
// so we can re-stat at exit and fail loudly if the test touched production.
const PROD_LEDGER = join(homedir(), "memory-system", "ledgers", "memory.jsonl");
let prodBefore = null;
try { const st = statSync(PROD_LEDGER); prodBefore = { mtimeMs: st.mtimeMs, size: st.size }; } catch {}
process.on("exit", () => {
  if (prodBefore == null) return;
  try {
    const st = statSync(PROD_LEDGER);
    if (st.mtimeMs !== prodBefore.mtimeMs || st.size !== prodBefore.size) {
      console.error("FATAL: production memory.jsonl changed during get test");
      process.exitCode = 2;
    }
  } catch {}
});

// ---------------------------------------------------------------------------
// Fixture ledger — three rows shaped like the live ledger + trailing newline.
// ---------------------------------------------------------------------------
const FIXTURE_A = {
  id: "mem_f1test01",
  kind: "fact",
  source: "mail",
  content: "Ada: the Examplewave interview slot is Thursday at 3pm; bring the deck.",
  source_refs: [
    {
      source: "mail",
      source_msg_id: "rowid:42",
      via: "original",
      corroboration_event_id: null,
      consent_basis: "third_party_inferred",
    },
  ],
  provenance: {
    agent_id: "daemons/watermark.js",
    conversation_id: null,
    confidence: "pre_distilled",
  },
  features: {
    embedding_model_version: "qwen3-embedding-8b-fp16",
    entities: [],
    time_anchors: [],
    attribution: { sender_id: "a@x.test", sender_name: "Ada", is_outgoing: false },
  },
  parties: ["a@x.test", "b@x.test"],
  created_at: "2026-09-05T23:22:56.000Z",
  ts: "2026-09-05T23:22:56.000Z",
  embedding_4096: new Array(4096).fill(0),
  checksum: "sha256:f1fixture",
};
const FIXTURE_B = {
  id: "rec_f1test02",
  kind: "reconstructed",
  content: "Thread: Ada scheduled the Examplewave interview for Thursday.",
  derived_from: ["mem_f1test01"],
  source_refs: [{ event_id: "mem_f1test01", consent_basis: "first_party", role: "derived_from" }],
  provenance: { agent_id: "daemons/synthesis.js", conversation_id: null, confidence: 1 },
  created_at: "2026-09-06T00:00:00.000Z",
  ts: "2026-09-06T00:00:00.000Z",
  superseded_by: null,
  reframed_by: null,
  rescinded_at: null,
};
const FIXTURE_C = {
  id: "mem_f1test03",
  kind: "policy",
  policy_kind: "salience.recall_feedback",
  targets: [],
  ts: "2026-09-06T01:00:00.000Z",
};
writeFileSync(
  LEDGER_PATH,
  [FIXTURE_A, FIXTURE_B, FIXTURE_C].map((r) => JSON.stringify(r)).join("\n") + "\n",
);
const fixtureHash = () =>
  createHash("sha256").update(readFileSync(LEDGER_PATH)).digest("hex");
const FIXTURE_HASH_INITIAL = fixtureHash();

// ---------------------------------------------------------------------------
// Imports (after env redirect).
// ---------------------------------------------------------------------------
const { executeTool, toolCount, listTools } = await import("../../lib/dispatch.js");
const { ERROR_CODES } = await import("../../lib/error-codes.js");
const { __resolveProvenanceAttribution } = await import("../../lib/tools/recall.js");
const { projectSourceRefs, projectMemoryEvent } = await import("../../lib/tools/get.js");
const { _resetOffsetCaches, _awaitPendingSidecarWrites } = await import(
  "../../lib/recall/ledger-offset-index.js"
);
const { _awaitPendingGraphCachePersists } = await import(
  "../../lib/synthesis/derivation-graph.js"
);

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------
let failures = 0;
function check(name, fn) {
  try {
    fn();
    process.stdout.write(`PASS  ${name}\n`);
  } catch (e) {
    failures++;
    process.stdout.write(`FAIL  ${name}\n      ${e && e.message ? e.message : e}\n`);
  }
}
const get = (id) => executeTool("memory_get", { id });
const ATTRIBUTION_KEYS = ["parties", "direction", "authored_by", "chat_type", "reply_to", "fwd_from"];
const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k]]));

// ===========================================================================
// 1. Registration.
// ===========================================================================
check("1: memory_get registered; toolCount==14; strict inputSchema", () => {
  assert.equal(toolCount(), 14, "toolCount stays 14 (no new tools)");
  const t = listTools().find((x) => x.name === "memory_get");
  assert.ok(t, "listTools must include memory_get");
  assert.equal(t.inputSchema.type, "object");
  assert.equal(t.inputSchema.additionalProperties, false, "strict schema");
  assert.deepEqual(t.inputSchema.required, ["id"]);
});

// ===========================================================================
// 2 + 3 + 4 + 11(a) + 12. The fact row.
// ===========================================================================
const envA = await get(FIXTURE_A.id);

check("2: fact row — real content + provenance + source_refs, not a stub", () => {
  assert.equal(envA.ok, true, "get(a) ok: " + JSON.stringify(envA.error));
  const d = envA.data;
  assert.equal(d.id, FIXTURE_A.id);
  assert.equal(d.kind, "fact");
  assert.equal(d.content, FIXTURE_A.content, "full content, not a stub string");
  assert.equal(d.provenance.source, "mail");
  assert.equal(d.provenance.ts, FIXTURE_A.ts);
  assert.equal(d.provenance.confidence, "pre_distilled");
  assert.equal(d.provenance.agent_id, "daemons/watermark.js");
  assert.deepEqual(d.provenance.parties, FIXTURE_A.parties);
  assert.equal(d.provenance.direction, "incoming");
  assert.equal(d.provenance.authored_by, "Ada");
  assert.equal(d.source_refs.length, 1);
  assert.equal(d.source_refs[0].source, "mail");
  assert.equal(d.source_refs[0].source_msg_id, "rowid:42");
  assert.equal(d.source_refs[0].via, "original");
  assert.equal(d.source_refs[0].corroboration_event_id, null);
  assert.equal(d.source_refs[0].consent_basis, "third_party_inferred", "passthrough keys kept");
  assert.equal(d.features.embedding_model_version, "qwen3-embedding-8b-fp16");
  assert.deepEqual(d.features.attribution, FIXTURE_A.features.attribution, "attribution as stored");
  assert.equal(d.created_at, FIXTURE_A.created_at);
  assert.equal(d.superseded_by, null);
  assert.equal(d.reframed_by, null);
  assert.equal(d.rescinded_at, null);
  assert.deepEqual(d.derived_from, []);
});

check("3: no vector leak — embedding_4096 / checksum absent; payload < 20 KB", () => {
  const s = JSON.stringify(envA.data);
  assert.ok(!s.includes("embedding_4096"), "serialized data must not mention embedding_4096");
  assert.ok(!s.includes("checksum"), "serialized data must not mention checksum");
  assert.equal(envA.data.embedding_4096, undefined);
  assert.equal(envA.data.embedding, undefined);
  assert.equal(envA.data.checksum, undefined);
  assert.equal(envA.data.features.embedding_4096, undefined);
  assert.ok(s.length < 20 * 1024, `serialized data ${s.length} bytes must be < 20 KB`);
});

check("4: cross-tool parity — provenance attribution equals recall's resolver", () => {
  const expected = __resolveProvenanceAttribution(FIXTURE_A);
  assert.deepEqual(pick(envA.data.provenance, ATTRIBUTION_KEYS), pick(expected, ATTRIBUTION_KEYS));
  assert.equal(expected.direction, "incoming", "sanity: resolver itself says incoming");
});

// ===========================================================================
// 5. Reconstructed row.
// ===========================================================================
const envB = await get(FIXTURE_B.id);
check("5: reconstructed row — kind, derived_from, source_refs[0].event_id, content", () => {
  assert.equal(envB.ok, true, "get(b) ok: " + JSON.stringify(envB.error));
  const d = envB.data;
  assert.equal(d.kind, "reconstructed");
  assert.deepEqual(d.derived_from, ["mem_f1test01"]);
  assert.equal(d.source_refs[0].event_id, "mem_f1test01");
  assert.equal(d.source_refs[0].role, "derived_from");
  assert.equal(d.source_refs[0].via, "original", "via defaulted on the reconstructed ref form");
  assert.equal(d.content, FIXTURE_B.content);
  assert.equal(d.provenance.confidence, 1, "confidence surfaced as stored (number on reconstructed rows)");
});

// ===========================================================================
// 6. Policy row.
// ===========================================================================
const envC = await get(FIXTURE_C.id);
check("6: policy row — kind policy, content \"\", derived_from [], rescinded_at null", () => {
  assert.equal(envC.ok, true, "get(c) ok: " + JSON.stringify(envC.error));
  const d = envC.data;
  assert.equal(d.kind, "policy");
  assert.equal(d.content, "");
  assert.deepEqual(d.derived_from, []);
  assert.equal(d.rescinded_at, null);
  assert.deepEqual(d.source_refs, []);
  assert.equal(d.features.embedding_model_version, null, "guaranteed key, null when absent");
  assert.equal(d.provenance.source, "memory_ledger", "default source when the row has none");
});

// ===========================================================================
// 7. Unknown id.
// ===========================================================================
const envMissing = await get("mem_does_not_exist");
check("7: unknown id → NOT_FOUND", () => {
  assert.equal(envMissing.ok, false);
  assert.equal(envMissing.error.code, ERROR_CODES.NOT_FOUND);
  assert.equal(envMissing.data, null);
});

// ===========================================================================
// 8. Legacy prefix routing is dead; the index tail-merges an append.
// ===========================================================================
const envMissingPrefix = await get("missing_x");
const APPENDED = {
  id: "policy_real",
  kind: "fact",
  source: "manual",
  content: "A fact whose id merely starts with policy_.",
  source_refs: [{ source: "manual", source_msg_id: "op:1", consent_basis: "first_party" }],
  provenance: { agent_id: "operator", conversation_id: null, confidence: "high" },
  features: { embedding_model_version: null },
  created_at: "2026-09-07T00:00:00.000Z",
  ts: "2026-09-07T00:00:00.000Z",
};
appendFileSync(LEDGER_PATH, JSON.stringify(APPENDED) + "\n");
const envAppended = await get("policy_real");
check("8: prefix routing gone — missing_x is NOT_FOUND by absence; policy_real reads as a fact", () => {
  assert.equal(envMissingPrefix.ok, false);
  assert.equal(envMissingPrefix.error.code, ERROR_CODES.NOT_FOUND);
  assert.equal(envAppended.ok, true, "appended row visible: " + JSON.stringify(envAppended.error));
  assert.equal(envAppended.data.kind, "fact", "kind comes from the row, not the id prefix");
  assert.equal(envAppended.data.content, APPENDED.content);
  assert.equal(envAppended.data.source_refs[0].via, "original", "via defaulted when absent");
  assert.equal(envAppended.data.source_refs[0].corroboration_event_id, null);
});

// ===========================================================================
// 9. Argument validation.
// ===========================================================================
const envNullId = await executeTool("memory_get", { id: null });
const envExtra = await executeTool("memory_get", { id: "x", extra: 1 });
check("9: {id:null} and {id:'x', extra:1} → INVALID_ARGUMENTS", () => {
  assert.equal(envNullId.ok, false);
  assert.equal(envNullId.error.code, ERROR_CODES.INVALID_ARGUMENTS);
  assert.equal(envExtra.ok, false);
  assert.equal(envExtra.error.code, ERROR_CODES.INVALID_ARGUMENTS);
});

// ===========================================================================
// 11. Thread relation via the derivation graph (before the ledger is deleted).
// ===========================================================================
const THIS_FILE = fileURLToPath(import.meta.url);
const GET_JS = join(THIS_FILE, "..", "..", "..", "lib", "tools", "get.js");
const CONV_INDEX_NEEDLE = ["conversation-index", "js"].join(".");
check("11: derived_into — a:[rec_f1test02], b:[]; conversation_id is the row value; no index import", () => {
  assert.deepEqual(envA.data.derived_into, ["rec_f1test02"], "one hop up reverseAdj");
  assert.deepEqual(envB.data.derived_into, [], "graph loaded and found nothing → [] not null");
  assert.equal(envA.data.provenance.conversation_id, null);
  assert.equal(envB.data.provenance.conversation_id, null);
  const testSrc = readFileSync(THIS_FILE, "utf8");
  const getSrc = readFileSync(GET_JS, "utf8");
  assert.ok(!testSrc.includes(CONV_INDEX_NEEDLE), "test never imports the conversation index");
  assert.ok(!getSrc.includes(CONV_INDEX_NEEDLE), "get.js never imports the conversation index");
  assert.ok(!getSrc.includes("loadLedgerRowsByIds"), "get.js never uses the stream-fallback wrapper");
  assert.ok(!getSrc.includes("streamLedgerLines"), "get.js never streams the ledger");
  assert.ok(!getSrc.includes("readFileSync"), "get.js never readFileSync's the ledger");
});
check("11b: graph cold-built from the fixture — fixture ledger bytes unchanged (post-append hash stable)", () => {
  // The append in group 8 is the only sanctioned change since the initial
  // snapshot; re-derive the expected bytes and compare exactly.
  const expected = createHash("sha256")
    .update(
      Buffer.concat([
        Buffer.from(
          [FIXTURE_A, FIXTURE_B, FIXTURE_C].map((r) => JSON.stringify(r)).join("\n") + "\n",
        ),
        Buffer.from(JSON.stringify(APPENDED) + "\n"),
      ]),
    )
    .digest("hex");
  assert.equal(fixtureHash(), expected, "ledger bytes are exactly fixture + one append");
  assert.notEqual(FIXTURE_HASH_INITIAL, expected, "sanity: the append changed the hash");
});

// ===========================================================================
// 12. Export parity for F3.
// ===========================================================================
check("12: projectSourceRefs / projectMemoryEvent exported; null derived_into preserved", () => {
  assert.deepEqual(projectSourceRefs(FIXTURE_A), envA.data.source_refs);
  assert.deepEqual(projectSourceRefs(FIXTURE_C), []);
  const p = projectMemoryEvent(FIXTURE_A, { derivedInto: null });
  assert.equal(p.derived_into, null, "null is preserved, never coerced to []");
  assert.equal(projectMemoryEvent(FIXTURE_A).derived_into, null, "absent opts → null");
  assert.deepEqual(projectMemoryEvent(FIXTURE_A, { derivedInto: [] }).derived_into, []);
  assert.equal(p.embedding_4096, undefined);
  assert.equal(p.checksum, undefined);
  assert.deepEqual(
    { ...p, derived_into: envA.data.derived_into },
    envA.data,
    "handler output is exactly the pure projection plus derived_into",
  );
});

// ===========================================================================
// 10. Missing ledger → NOT_FOUND, not INTERNAL_ERROR (last: destroys the fixture).
// ===========================================================================
await _awaitPendingSidecarWrites();
await _awaitPendingGraphCachePersists();
rmSync(LEDGER_PATH, { force: true });
_resetOffsetCaches();
const envNoLedger = await get(FIXTURE_A.id);
check("10: missing ledger → NOT_FOUND, never INTERNAL_ERROR", () => {
  assert.equal(envNoLedger.ok, false);
  assert.equal(envNoLedger.error.code, ERROR_CODES.NOT_FOUND);
  assert.notEqual(envNoLedger.error.code, ERROR_CODES.INTERNAL_ERROR);
});

// ---------------------------------------------------------------------------
// Drain fire-and-forget sidecar / graph-cache writes before the temp root is
// removed on exit, so a late write never races rmSync.
await _awaitPendingSidecarWrites();
await _awaitPendingGraphCachePersists();

if (failures > 0) {
  process.stdout.write(`\nFAIL  get.test.mjs — ${failures} failing assertion group(s)\n`);
  process.exit(1);
}
process.stdout.write("\nALL PASS  get.test.mjs\n");
process.exit(0);
