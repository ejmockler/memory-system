// damping-log.test.mjs — substrate-tier coverage for the private damping log
// (F-SYN-SUBSTRATE-DAMPING-LOG). Pins the authoritative envelope from
// docs/specs/synthesis/recall-log-split.md § 4.7.
//
// Coverage:
//   - computeTurnWindowId determinism + base64url shape
//   - buildEnvelope per signal_kind (verify 5 different envelopes;
//     I3/I4/I5 null-rules)
//   - append + read round-trip for each signal_kind
//   - expunge + read filters expunged rows (I12)
//   - File mode 0600 enforced (I14)
//   - private-invariant test (path-blocklist guard / I8)
//
// Run: node test/synthesis/damping-log.test.mjs

import {
  mkdtempSync,
  rmSync,
  statSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

// Hermeticity: pin MEMORY_ROOT / POLICY_BASE_DIR before importing the module
// so every write/read lands in the test fixture directory.
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-dl-test-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
const POLICY_DIR = join(MEMORY_ROOT, "policy");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = POLICY_DIR;

// Ensure the policy dir exists (the substrate's openSync will create the
// file but not the directory).
import { mkdirSync } from "node:fs";
mkdirSync(POLICY_DIR, { recursive: true });

const {
  RECALL_LOG_SCHEMA_VERSION,
  RECALL_LOG_SCHEMA_VERSION_NUMERIC,
  SIGNAL_KINDS,
  EXPUNGE_GLOBAL_SENTINEL,
  computeTurnWindowId,
  computeConversationIdHash,
  buildEnvelope,
  appendSurfacing,
  appendEngagement,
  appendInheritedEngagement,
  appendCrowdedNeighborhood,
  expunge,
  readWindowedSignals,
  dampingLogPath,
  _resetForTest,
  _assertPathBlocklist,
} = await import("../../lib/synthesis/damping-log.js");

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

function assertEqual(actual, expected, msg) {
  const ok = actual === expected;
  if (ok) passed++;
  else {
    failed++;
    console.error(
      `FAIL: ${msg}\n   actual:   ${JSON.stringify(actual)}\n   expected: ${JSON.stringify(expected)}`,
    );
  }
}

function assertThrows(fn, msg) {
  try {
    fn();
  } catch {
    passed++;
    return;
  }
  failed++;
  console.error(`FAIL: ${msg} (expected throw, none raised)`);
}

async function assertThrowsAsync(fn, msg) {
  try {
    await fn();
  } catch {
    passed++;
    return;
  }
  failed++;
  console.error(`FAIL: ${msg} (expected throw, none raised)`);
}

// ===========================================================================
// 1. SCHEMA CONSTANTS
// ===========================================================================

assertEqual(RECALL_LOG_SCHEMA_VERSION, "v1", "RECALL_LOG_SCHEMA_VERSION is 'v1'");
assertEqual(
  RECALL_LOG_SCHEMA_VERSION_NUMERIC,
  1,
  "RECALL_LOG_SCHEMA_VERSION_NUMERIC is 1",
);
assertEqual(SIGNAL_KINDS.SURFACING, "surfacing", "SIGNAL_KINDS.SURFACING string");
assertEqual(SIGNAL_KINDS.ENGAGEMENT, "engagement", "SIGNAL_KINDS.ENGAGEMENT string");
assertEqual(
  SIGNAL_KINDS.ENGAGEMENT_INHERITED,
  "engagement_inherited",
  "SIGNAL_KINDS.ENGAGEMENT_INHERITED string",
);
assertEqual(
  SIGNAL_KINDS.CROWDED_NEIGHBORHOOD,
  "crowded_neighborhood",
  "SIGNAL_KINDS.CROWDED_NEIGHBORHOOD string",
);
assertEqual(SIGNAL_KINDS.EXPUNGED, "expunged", "SIGNAL_KINDS.EXPUNGED string");

// SIGNAL_KINDS is frozen (no accidental writes).
assertThrows(() => {
  "use strict";
  SIGNAL_KINDS.NEW_KIND = "x";
}, "SIGNAL_KINDS is frozen");

// ===========================================================================
// 2. computeTurnWindowId — determinism + base64url shape
// ===========================================================================

const twid1 = computeTurnWindowId({
  conversation_id: "cc-2026-06-18-abc",
  base_turn_index: 0,
  window_size: 3,
});
const twid2 = computeTurnWindowId({
  conversation_id: "cc-2026-06-18-abc",
  base_turn_index: 0,
  window_size: 3,
});
assertEqual(twid1, twid2, "computeTurnWindowId is deterministic");

// base64url-encoded sha256 is 43 chars (no padding).
assertEqual(twid1.length, 43, "computeTurnWindowId returns 43-char base64url");
assert(/^[A-Za-z0-9_-]+$/.test(twid1), "computeTurnWindowId returns base64url chars only");

// Different conversation_id → different hash.
const twidOther = computeTurnWindowId({
  conversation_id: "cc-2026-06-18-different",
  base_turn_index: 0,
  window_size: 3,
});
assert(twid1 !== twidOther, "computeTurnWindowId changes with conversation_id");

// Different base_turn_index → different hash.
const twidNextWindow = computeTurnWindowId({
  conversation_id: "cc-2026-06-18-abc",
  base_turn_index: 1,
  window_size: 3,
});
assert(twid1 !== twidNextWindow, "computeTurnWindowId changes with base_turn_index");

// Different window_size → different hash.
const twidLargerWindow = computeTurnWindowId({
  conversation_id: "cc-2026-06-18-abc",
  base_turn_index: 0,
  window_size: 5,
});
assert(twid1 !== twidLargerWindow, "computeTurnWindowId changes with window_size");

// Reference impl: recompute manually and compare byte-for-byte. This is the
// CI fixture invariant (I9) — drift fails the test.
{
  const sep = Buffer.from([0x1f]);
  const baseBuf = Buffer.alloc(8);
  baseBuf.writeBigUInt64BE(BigInt(0));
  const sizeBuf = Buffer.alloc(8);
  sizeBuf.writeBigUInt64BE(BigInt(3));
  const h = createHash("sha256");
  h.update(Buffer.from("cc-2026-06-18-abc", "utf8"));
  h.update(sep);
  h.update(baseBuf);
  h.update(sep);
  h.update(sizeBuf);
  const expected = h.digest("base64url");
  assertEqual(twid1, expected, "computeTurnWindowId matches reference impl byte-exact (I9)");
}

// Validation.
assertThrows(
  () => computeTurnWindowId({ conversation_id: 42, base_turn_index: 0, window_size: 3 }),
  "computeTurnWindowId rejects non-string conversation_id",
);
assertThrows(
  () => computeTurnWindowId({ conversation_id: "x", base_turn_index: -1, window_size: 3 }),
  "computeTurnWindowId rejects negative base_turn_index",
);
assertThrows(
  () => computeTurnWindowId({ conversation_id: "x", base_turn_index: 0, window_size: 0 }),
  "computeTurnWindowId rejects window_size=0",
);

// ===========================================================================
// 3. computeConversationIdHash
// ===========================================================================

const cidHash = computeConversationIdHash("cc-2026-06-18-abc");
assertEqual(cidHash.length, 43, "computeConversationIdHash returns 43-char base64url");
assertEqual(
  cidHash,
  createHash("sha256").update("cc-2026-06-18-abc", "utf8").digest("base64url"),
  "computeConversationIdHash matches reference impl",
);

// ===========================================================================
// 4. buildEnvelope — 5 different envelopes (one per signal_kind)
// ===========================================================================

const TWID = computeTurnWindowId({
  conversation_id: "cc-2026-06-18-abc",
  base_turn_index: 0,
  window_size: 3,
});
const CID_HASH = computeConversationIdHash("cc-2026-06-18-abc");

// 4.A — surfacing envelope
const envSurfacing = buildEnvelope({
  signal_kind: SIGNAL_KINDS.SURFACING,
  memory_id: "mem_robin_meeting",
  turn_window_id: TWID,
  recall_id: "rec_01HVX",
  conversation_id_hash: CID_HASH,
  fields: { surfaced_strength: 0.81, position: 0, score: 0.81, propensity: 0.42 },
});
assertEqual(envSurfacing.signal_kind, "surfacing", "buildEnvelope surfacing signal_kind");
assertEqual(envSurfacing.schema_version, 1, "buildEnvelope schema_version=1");
assertEqual(envSurfacing.memory_id, "mem_robin_meeting", "surfacing memory_id");
assertEqual(envSurfacing.recall_id, "rec_01HVX", "surfacing recall_id");
assertEqual(envSurfacing.fields.position, 0, "surfacing fields.position");

// 4.B — engagement envelope
const envEngagement = buildEnvelope({
  signal_kind: SIGNAL_KINDS.ENGAGEMENT,
  memory_id: "mem_robin_meeting",
  turn_window_id: TWID,
  recall_id: "rec_01HVX",
  conversation_id_hash: CID_HASH,
  fields: {
    engagement_class: "direct",
    engagement_weight: 1.0,
    evidence_span_hash: "6ab",
    detector_version: "engagement-detector@1.0.0",
  },
});
assertEqual(envEngagement.signal_kind, "engagement", "buildEnvelope engagement signal_kind");
assertEqual(
  envEngagement.fields.engagement_class,
  "direct",
  "engagement fields.engagement_class",
);

// 4.C — engagement_inherited envelope (recall_id MUST be null per I4)
const envInherited = buildEnvelope({
  signal_kind: SIGNAL_KINDS.ENGAGEMENT_INHERITED,
  memory_id: "mem_alex_commit_a",
  turn_window_id: TWID,
  recall_id: null,
  conversation_id_hash: CID_HASH,
  fields: {
    inherited_strength: 0.5,
    source_engagement_recall_id: "rec_01HVX",
    source_memory_id: "mem_alex_pr",
    derivation_depth: 1,
  },
});
assertEqual(
  envInherited.signal_kind,
  "engagement_inherited",
  "buildEnvelope engagement_inherited signal_kind",
);
assertEqual(envInherited.recall_id, null, "engagement_inherited recall_id null (I4)");

// 4.D — crowded_neighborhood envelope (memory_id MUST be null per I3)
const envCrowded = buildEnvelope({
  signal_kind: SIGNAL_KINDS.CROWDED_NEIGHBORHOOD,
  memory_id: null,
  turn_window_id: TWID,
  recall_id: "rec_01HVZ",
  conversation_id_hash: CID_HASH,
  fields: {
    entity_set_hash: "jK2",
    entity_set: ["entity_alex_person", "entity_thursday"],
    time_window_start: null,
    time_window_end: null,
    candidates_pre_truncation: ["mem_a", "mem_b"],
  },
});
assertEqual(
  envCrowded.signal_kind,
  "crowded_neighborhood",
  "buildEnvelope crowded_neighborhood signal_kind",
);
assertEqual(envCrowded.memory_id, null, "crowded_neighborhood memory_id null (I3)");

// 4.E — expunged envelope (recall_id + conversation_id_hash MUST be null per I4 + I5)
const envExpunged = buildEnvelope({
  signal_kind: SIGNAL_KINDS.EXPUNGED,
  memory_id: "mem_alex_dm",
  turn_window_id: EXPUNGE_GLOBAL_SENTINEL,
  recall_id: null,
  conversation_id_hash: null,
  fields: { excise_reason: "silent_excise" },
});
assertEqual(envExpunged.signal_kind, "expunged", "buildEnvelope expunged signal_kind");
assertEqual(envExpunged.recall_id, null, "expunged recall_id null (I4)");
assertEqual(envExpunged.conversation_id_hash, null, "expunged conversation_id_hash null (I5)");
assertEqual(
  envExpunged.turn_window_id,
  "EXPUNGE_GLOBAL",
  "expunged turn_window_id sentinel",
);

// Distinctness: 5 envelopes serialise to 5 different JSON strings.
const serialised = [envSurfacing, envEngagement, envInherited, envCrowded, envExpunged].map(
  (e) => JSON.stringify(e),
);
const uniq = new Set(serialised);
assertEqual(uniq.size, 5, "5 signal_kinds produce 5 distinct envelopes");

// I3 enforcement — non-crowded with null memory_id throws.
assertThrows(
  () =>
    buildEnvelope({
      signal_kind: SIGNAL_KINDS.SURFACING,
      memory_id: null,
      turn_window_id: TWID,
      recall_id: "rec_x",
      conversation_id_hash: CID_HASH,
      fields: {},
    }),
  "buildEnvelope rejects null memory_id on non-crowded (I3)",
);

// I3 enforcement — crowded with non-null memory_id throws.
assertThrows(
  () =>
    buildEnvelope({
      signal_kind: SIGNAL_KINDS.CROWDED_NEIGHBORHOOD,
      memory_id: "mem_x",
      turn_window_id: TWID,
      recall_id: "rec_x",
      conversation_id_hash: CID_HASH,
      fields: {},
    }),
  "buildEnvelope rejects non-null memory_id on crowded (I3)",
);

// I4 enforcement — surfacing with null recall_id throws.
assertThrows(
  () =>
    buildEnvelope({
      signal_kind: SIGNAL_KINDS.SURFACING,
      memory_id: "mem_x",
      turn_window_id: TWID,
      recall_id: null,
      conversation_id_hash: CID_HASH,
      fields: {},
    }),
  "buildEnvelope rejects null recall_id on surfacing (I4)",
);

// I4 enforcement — expunged with non-null recall_id throws.
assertThrows(
  () =>
    buildEnvelope({
      signal_kind: SIGNAL_KINDS.EXPUNGED,
      memory_id: "mem_x",
      turn_window_id: EXPUNGE_GLOBAL_SENTINEL,
      recall_id: "rec_x",
      conversation_id_hash: null,
      fields: {},
    }),
  "buildEnvelope rejects non-null recall_id on expunged (I4)",
);

// I5 enforcement — surfacing with null conversation_id_hash throws.
assertThrows(
  () =>
    buildEnvelope({
      signal_kind: SIGNAL_KINDS.SURFACING,
      memory_id: "mem_x",
      turn_window_id: TWID,
      recall_id: "rec_x",
      conversation_id_hash: null,
      fields: {},
    }),
  "buildEnvelope rejects null conversation_id_hash on surfacing (I5)",
);

// I5 enforcement — expunged with non-null conversation_id_hash throws.
assertThrows(
  () =>
    buildEnvelope({
      signal_kind: SIGNAL_KINDS.EXPUNGED,
      memory_id: "mem_x",
      turn_window_id: EXPUNGE_GLOBAL_SENTINEL,
      recall_id: null,
      conversation_id_hash: CID_HASH,
      fields: {},
    }),
  "buildEnvelope rejects non-null conversation_id_hash on expunged (I5)",
);

// Invalid signal_kind throws.
assertThrows(
  () =>
    buildEnvelope({
      signal_kind: "unknown",
      memory_id: "mem_x",
      turn_window_id: TWID,
      recall_id: "rec_x",
      conversation_id_hash: CID_HASH,
      fields: {},
    }),
  "buildEnvelope rejects unknown signal_kind",
);

// ===========================================================================
// 5. Append + read round-trip — one per signal_kind
// ===========================================================================

_resetForTest();

const RID_A = "rec_round_trip_A";
const RID_B = "rec_round_trip_B";

// 5.A — surfacing
const surfacingRow = await appendSurfacing({
  memory_id: "mem_alpha",
  turn_window_id: TWID,
  recall_id: RID_A,
  conversation_id_hash: CID_HASH,
  position: 0,
  score: 0.81,
  propensity: 0.42,
});
assertEqual(surfacingRow.signal_kind, "surfacing", "appendSurfacing wrote signal_kind");
assertEqual(
  surfacingRow.fields.surfaced_strength,
  0.81,
  "appendSurfacing computed surfaced_strength at position 0",
);
assert(
  typeof surfacingRow.ts === "string" && surfacingRow.ts.length > 0,
  "appendSurfacing stamped ts",
);

// 5.B — engagement
await appendEngagement({
  memory_id: "mem_alpha",
  turn_window_id: TWID,
  recall_id: RID_A,
  conversation_id_hash: CID_HASH,
  engagement_class: "direct",
  engagement_weight: 1.0,
  evidence_span_hash: "abc",
  detector_version: "engagement-detector@1.0.0",
});

// 5.C — engagement_inherited
await appendInheritedEngagement({
  memory_id: "mem_beta",
  turn_window_id: TWID,
  conversation_id_hash: CID_HASH,
  source_engagement_recall_id: RID_A,
  source_memory_id: "mem_alpha",
  derivation_depth: 1,
  inherited_strength: 0.5,
});

// 5.D — crowded_neighborhood
await appendCrowdedNeighborhood({
  turn_window_id: TWID,
  recall_id: RID_B,
  conversation_id_hash: CID_HASH,
  entity_set: ["entity_x", "entity_y"],
  entity_set_hash: "hash_xy",
  time_window_start: null,
  time_window_end: null,
  candidates_pre_truncation: ["mem_c1", "mem_c2"],
});

// 5.E — surfacing for a second memory that we'll later expunge
await appendSurfacing({
  memory_id: "mem_to_expunge",
  turn_window_id: TWID,
  recall_id: RID_A,
  conversation_id_hash: CID_HASH,
  position: 1,
  score: 0.6,
  propensity: 0.3,
});

// Round-trip read: filter by memory_id="mem_alpha" returns 2 rows (surfacing + engagement).
{
  const rows = await readWindowedSignals({ memory_id: "mem_alpha" });
  assertEqual(rows.length, 2, "read mem_alpha returns 2 rows (surfacing + engagement)");
  const kinds = rows.map((r) => r.signal_kind).sort();
  assertEqual(
    JSON.stringify(kinds),
    JSON.stringify(["engagement", "surfacing"]),
    "mem_alpha rows are engagement + surfacing",
  );
}

// Filter by signal_kinds=[engagement_inherited] returns the mem_beta inherited row.
{
  const rows = await readWindowedSignals({
    signal_kinds: [SIGNAL_KINDS.ENGAGEMENT_INHERITED],
  });
  assertEqual(rows.length, 1, "read engagement_inherited returns 1 row");
  assertEqual(rows[0].memory_id, "mem_beta", "engagement_inherited row memory_id");
  assertEqual(
    rows[0].fields.derivation_depth,
    1,
    "engagement_inherited row derivation_depth",
  );
}

// Filter by signal_kinds=[crowded_neighborhood] returns the memory_id=null row.
{
  const rows = await readWindowedSignals({
    signal_kinds: [SIGNAL_KINDS.CROWDED_NEIGHBORHOOD],
  });
  assertEqual(rows.length, 1, "read crowded_neighborhood returns 1 row");
  assertEqual(
    rows[0].memory_id,
    null,
    "crowded_neighborhood row has null memory_id (I3)",
  );
  assertEqual(
    JSON.stringify(rows[0].fields.entity_set),
    JSON.stringify(["entity_x", "entity_y"]),
    "crowded_neighborhood entity_set round-tripped",
  );
}

// Filter by turn_window_id returns ALL rows in that window (5 written so far).
{
  const rows = await readWindowedSignals({ turn_window_id: TWID });
  assertEqual(rows.length, 5, "read by turn_window_id returns all 5 rows in window");
}

// ===========================================================================
// 6. expunge + read filters expunged rows (I12)
// ===========================================================================

await expunge({ memory_id: "mem_to_expunge", excise_reason: "silent_excise" });

// Default read for mem_to_expunge returns NOTHING — its surfacing row is filtered.
{
  const rows = await readWindowedSignals({ memory_id: "mem_to_expunge" });
  assertEqual(rows.length, 0, "expunged memory_id returns 0 rows by default (I12)");
}

// Calibration-replay path: explicit signal_kinds=[expunged] sees the tombstone.
// We use the explicit signal_kinds filter so the tombstone-bypass triggers
// (the default read filters expunged memory_ids).
{
  const rows = await readWindowedSignals({
    memory_id: "mem_to_expunge",
    signal_kinds: [SIGNAL_KINDS.EXPUNGED, SIGNAL_KINDS.SURFACING],
  });
  // With the EXPUNGED kind in the filter, the bypass fires and we see all the
  // rows for mem_to_expunge (the surfacing row + the expunged tombstone).
  assertEqual(rows.length, 2, "calibration replay sees expunged tombstone + surfacing");
  const kinds = rows.map((r) => r.signal_kind).sort();
  assertEqual(
    JSON.stringify(kinds),
    JSON.stringify(["expunged", "surfacing"]),
    "calibration replay returns surfacing + expunged",
  );
}

// Co-bucketed memories unaffected — mem_alpha's rows still readable post-excise.
// This is the open-problems.md #4 invariant: expunging one memory_id does NOT
// erase co-surfaced memories' signal.
{
  const rows = await readWindowedSignals({ memory_id: "mem_alpha" });
  assertEqual(
    rows.length,
    2,
    "co-bucketed memory unaffected by sibling expunge (open-problems #4)",
  );
}

// ===========================================================================
// 7. File mode 0600 (I14)
// ===========================================================================

const logPath = dampingLogPath();
assert(existsSync(logPath), "damping log file exists after writes");
const st = statSync(logPath);
// mode 0o777 mask strips file-type bits; we want the permission bits.
const perm = st.mode & 0o777;
assertEqual(perm, 0o600, "damping log file mode is 0600 (I14)");

// ===========================================================================
// 8. Append-only invariant (I1) + JSONL line format
// ===========================================================================

const fileText = readFileSync(logPath, "utf8");
const lines = fileText.split("\n").filter((l) => l !== "");
assert(lines.length >= 6, "damping log has 6+ rows after the round-trip");
// Every line parses as a valid JSON object with the canonical envelope keys.
for (const line of lines) {
  const parsed = JSON.parse(line);
  assert(
    typeof parsed.schema_version === "number" &&
      typeof parsed.signal_kind === "string" &&
      typeof parsed.turn_window_id === "string" &&
      typeof parsed.ts === "string" &&
      typeof parsed.populator_version === "string" &&
      parsed.fields !== null &&
      typeof parsed.fields === "object",
    "every line conforms to envelope shape",
  );
}

// ===========================================================================
// 9. Private invariant — path-blocklist guard (I8 / S9)
// ===========================================================================

// Simulate a stack frame from a tool file: the guard MUST throw.
const fakeStackFromTool = `Error
    at Object.<anonymous> (/home/alex/projects/example-repo/mcp/lib/tools/memory_recall.js:42:13)
    at Module._compile (node:internal/modules/cjs/loader:1234:12)`;
assertThrows(
  () => _assertPathBlocklist(fakeStackFromTool),
  "_assertPathBlocklist throws when caller is under mcp/lib/tools/* (I8)",
);

// A non-tool caller (e.g. recall scorer) does NOT throw.
const fakeStackFromScorer = `Error
    at Object.<anonymous> (/home/alex/projects/example-repo/mcp/lib/recall/multi-feature-score.js:99:13)
    at Module._compile (node:internal/modules/cjs/loader:1234:12)`;
// We use a try/catch wrapper because the assertion helper expects a throw to
// pass; here we want to verify NO throw, which is the inverse.
{
  let threw = false;
  try {
    _assertPathBlocklist(fakeStackFromScorer);
  } catch {
    threw = true;
  }
  assert(!threw, "_assertPathBlocklist passes when caller is recall scorer (I8 allowlist)");
}

// ===========================================================================
// 10. Per-kind writer validation (kind enum guards)
// ===========================================================================

// appendEngagement rejects an unknown engagement_class.
await assertThrowsAsync(
  () =>
    appendEngagement({
      memory_id: "mem_x",
      turn_window_id: TWID,
      recall_id: RID_A,
      conversation_id_hash: CID_HASH,
      engagement_class: "agreement", // legacy 6-class taxonomy — REJECTED per § 6.7
      engagement_weight: 1.0,
      evidence_span_hash: "",
      detector_version: "engagement-detector@1.0.0",
    }),
  "appendEngagement rejects legacy 'agreement' class (5-class taxonomy fixed)",
);

// expunge rejects unknown excise_reason.
await assertThrowsAsync(
  () => expunge({ memory_id: "mem_x", excise_reason: "ungrounded_invented_reason" }),
  "expunge rejects unknown excise_reason",
);

// ===========================================================================
// Cleanup
// ===========================================================================

try {
  rmSync(TMP_ROOT, { recursive: true, force: true });
} catch {
  // ignore
}

console.error(`\ndamping-log: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
