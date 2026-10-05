// r25-end-to-end-cascade.test.mjs
//
// R25.5 INTEGRATION REGRESSION SUITE.
//
// Purpose: prevent the bug-mask that landed R25+R26. In that bundle each of
// the three CRIT-1 sub-bugs (a/b/c) was independently testable by unit tests,
// but at runtime they interlocked: the missing `await` (a) made every
// PROMOTE branch yield a Promise; the missing `promoteSourceRow` export (b)
// made the post-PROMOTE typeof guard silently no-op; and the missing
// raw_content -> content adapter (c) would have thrown synchronously HAD the
// await been there. The three bugs hid each other, so the unit suite stayed
// green while end-to-end produced 0 facts.
//
// This integration test boots the REAL watermark daemon's tickSourcesOnce
// against a synthetic source-tier ledger and asserts that memory.jsonl
// actually grows. Each of the three CRIT-1 bugs would fail at least one
// independent assertion below (T1 = adapter; T1 + T2 = promoteSourceRow
// export; T6 = TypeError-on-reload).
//
// Hermeticity: mkdtempSync root + MEMORY_ROOT / POLICY_BASE_DIR /
// STORAGE_BASE_DIR / LEDGERS_BASE_DIR env overrides applied BEFORE any
// dynamic import of daemons/watermark.js or mcp/lib/* modules. The real
// <checkout> tree is byte-identical pre/post (verified via
// snap() guard).
//
// Run: node test/integration/r25-end-to-end-cascade.test.mjs
// Exit 0 on full pass, non-zero on any failure.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// 0a. Daemon-quiesce gate (converged at e18).
//
// The HERMETIC production-paths assertion at the end of this test stats
// <checkout>/ledgers/memory.jsonl before and after, expecting
// byte-equality. A concurrent watermark daemon invalidates that through no
// fault of this test.
//
// This block used to be a PRIVATE copy of the gate: a two-entry list whose
// first entry (policy/distillation-state.json) stopped existing when R32
// retired the distiller, and whose second entry watched 1 of the 10 declared
// cascade sources — so it half-watched a phantom and missed most of the
// daemon. It is now the shared gate, whose set is DERIVED from
// CAPS.WATERMARK_SOURCES and tiered (gate vs note). See
// kb/test-discipline.md section 2 and mcp/test/_hermetic-daemon-skip.mjs.
//
// It must stay HERE — above section 0's hermetic-root setup — because the
// helper watches the LIVE tree and the call has to happen before any
// memory-system module is dynamically imported.
// ---------------------------------------------------------------------------
import { skipIfDaemonActive } from "../_hermetic-daemon-skip.mjs";

skipIfDaemonActive("r25-end-to-end-cascade");

// ---------------------------------------------------------------------------
// 0. Hermetic root + env BEFORE any dynamic import.
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const WATERMARK_JS = join(REPO_ROOT, "daemons", "watermark.js");

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-r25p5-e2e-"));
const HERMETIC_ROOT = join(TMP_ROOT, "memory-system");
const POLICY_DIR = join(HERMETIC_ROOT, "policy");
const STORAGE_DIR = join(HERMETIC_ROOT, "storage");
const LEDGERS_DIR = join(HERMETIC_ROOT, "ledgers");
const INDICES_DIR = join(HERMETIC_ROOT, "indices");
const SOURCES_DIR = join(STORAGE_DIR, "sources");
const QUEUE_DIR = join(STORAGE_DIR, "distillation-queue");
const QUEUE_PENDING_DIR = join(QUEUE_DIR, "pending");
const QUEUE_IN_FLIGHT_DIR = join(QUEUE_DIR, "in-flight");
const QUEUE_DONE_DIR = join(QUEUE_DIR, "done");
const QUEUE_FAILED_DIR = join(QUEUE_DIR, "failed");
const WATERMARK_STATE_DIR = join(STORAGE_DIR, "watermark-state");

for (const d of [
  HERMETIC_ROOT,
  POLICY_DIR,
  STORAGE_DIR,
  LEDGERS_DIR,
  INDICES_DIR,
  SOURCES_DIR,
  QUEUE_DIR,
  QUEUE_PENDING_DIR,
  QUEUE_IN_FLIGHT_DIR,
  QUEUE_DONE_DIR,
  QUEUE_FAILED_DIR,
  WATERMARK_STATE_DIR,
]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}

process.env.MEMORY_ROOT = HERMETIC_ROOT;
process.env.POLICY_BASE_DIR = POLICY_DIR;
process.env.STORAGE_BASE_DIR = STORAGE_DIR;
process.env.LEDGERS_BASE_DIR = LEDGERS_DIR;
// R29.3: the previous strategy (delete GEMINI_API_KEY + assume the cascade
// still PROMOTEs to memory.jsonl via the embed-pending fallback) was the
// EXACT failure mode being fixed in R29.3 CRIT-1: silent-PROMOTE-with-no-
// embedding writes rows that are unrecallable AND unrecoverable (cursor
// advance prevents retry). Under R29.3, the cascade returns EMBED_DEFERRED
// when the embedder is wired but fails, and the watermark parks the
// cursor. To still exercise the SUCCESS path (the original R25.5 CRIT-1
// regression surface), wire the deterministic stub embedder via the
// MEMORY_TEST_STUB_EMBEDDER env var. The shape-valid junk key satisfies
// the boot-time pool-shape validator; bytes never leave the process
// because the stub bypasses gemini-client transport.
process.env.MEMORY_TEST_STUB_EMBEDDER = "1";
process.env.GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || "AIzaJUNK_test_only_xxxxxxxxxxxxxxxxxx";
// b4: the stub embedder covers Layer-1 only; Layer-3 has a separate backend
// selector. An UNSET LOCAL_RERANKER_ENABLED falls through to
// CAPS.LOCAL_RERANKER_ENABLED (true), which skips the gemini key gate and
// points the default backend at _baseUrl() -> the LIVE rerank daemon on :8360,
// so this suite's T3 recall was reaching off-process. "0" is the tri-state OFF
// override (a `delete` is inert against a true CAP) and restores the gemini
// leg, which degrades on the junk key without transport.
process.env.LOCAL_RERANKER_ENABLED = "0";

// Production paths byte-equality snapshot (taken now; verified at exit).
const PROD_MEMORY = join(REPO_ROOT, "ledgers", "memory.jsonl");
const PROD_RECALL = join(REPO_ROOT, "ledgers", "recall.jsonl");
const PROD_INDICES = join(REPO_ROOT, "indices");
const PROD_SIGNING_KEY =
  join(REPO_ROOT, "policy", "distillation-signing-key.json");
function snap(p) {
  try {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "missing";
  }
}
const PROD_BEFORE = {
  memory: snap(PROD_MEMORY),
  recall: snap(PROD_RECALL),
  indices: snap(PROD_INDICES),
  signing_key: snap(PROD_SIGNING_KEY),
};

// Initialize the distillation signing key in the hermetic tree (so the
// cascade's downstream promoteSourceRow path can mint/verify if it walks
// that road).
{
  const initResult = spawnSync(
    "node",
    [
      "-e",
      `import('${"file://" + join(REPO_ROOT, "mcp", "lib", "daemon-token.js")}').then(m => { m.initSigningKey(); process.stdout.write('ok\\n'); }).catch(err => { process.stderr.write('init-fail: ' + err.message + '\\n'); process.exit(1); })`,
    ],
    {
      env: {
        ...process.env,
        MEMORY_ROOT: HERMETIC_ROOT,
        POLICY_BASE_DIR: POLICY_DIR,
      },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  if (initResult.status !== 0) {
    console.error(
      `setup: signing-key init failed status=${initResult.status} stderr=${(initResult.stderr || "").slice(0, 400)}`,
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// 1. Framework.
// ---------------------------------------------------------------------------
let failures = 0;
function record(label, ok, diag) {
  if (ok) {
    console.log(`PASS  ${label}` + (diag ? `  -- ${diag}` : ""));
  } else {
    failures += 1;
    console.log(`FAIL  ${label}  -- ${diag || "(no diagnostic)"}`);
  }
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((x) => x != null);
}

// ---------------------------------------------------------------------------
// 2. Synthetic source ledgers. The R25.5 spec asks for "10 per source × 5
// sources" but the production watermark daemon walks only the 4 non-wildcard
// entries in CAPS.WATERMARK_SOURCES (imessage, screentime, git-log,
// github-events) — `chat-claude-code-*` is a wildcard owned by tickOnce's
// per-conversation chat-ledger path, not by tickSourcesOnce. To preserve the
// "every source the cascade actually walks must yield >=1 PROMOTE" floor we
// scope T2 to those 4. The 5th "synthetic" source is therefore folded into
// the 4 existing ones (12 rows per source × 4 = 48 fixture rows), still
// satisfying the spec's "synthetic source ledger" deliverable.
//
// Schema follows real connectors:
//    - raw_content as an OBJECT (NOT a string). This is the adapter surface;
//      if salience.js:321's content-must-be-string assertion fires, CRIT-1c
//      is unmitigated and T1 fails.
//    - each row has source, source_msg_id, ts, raw_content, source_policy.
//
// Per-source 12-row layout:
//   - 2 rows engineered to DROP via Stage-0 (T4 coverage; gives margin so a
//     single engineering off-by-one doesn't accidentally drop the floor to 0).
//   - 10 rows engineered to PASS Stage-0 → salience PROMOTE branch.
// Total expected min: 4 PROMOTEs (one per source) for T2's per-source floor;
// actual will be much higher because most rows PROMOTE in a fresh
// memory.jsonl with novelty=1.0 (cold-start) modulo CRIT-6 mitigation.
//
// Authorship strategy: timestamps are spread 1 minute apart, well in the
// past relative to nowMs (Date(2026-05-01)), so the recency component
// neither saturates nor floors.
// ---------------------------------------------------------------------------

const BASE_TS_MS = Date.UTC(2026, 4, 1, 0, 0, 0); // 2026-05-01T00:00:00Z
function tsOf(idx) {
  return new Date(BASE_TS_MS + idx * 60_000).toISOString();
}

function makeImessageRow(i, dropMode) {
  // dropMode === "tapback"  -> Stage-0 DROP via associated_message_type
  // otherwise PASS (substantive text)
  const rc =
    dropMode === "tapback"
      ? {
          text: "Loved “…”",
          handle_id: "+15551234567",
          associated_message_type: 2000,
          is_from_me: 0,
        }
      : {
          text: `Confirming dinner Friday at the new ramen place near 4th and Pine, ${i}.`,
          handle_id: "+15551234567",
          associated_message_type: 0,
          is_from_me: 1,
        };
  return {
    id: `ulid_imsg_${String(i).padStart(8, "0")}`,
    ts: tsOf(i),
    source: "imessage",
    source_msg_id: `imsg-fixture-${i}`,
    parties: ["user", "+15551234567"],
    raw_content: rc,
    attachments: [],
    source_policy: {
      deletion_semantics: "full_excise",
      consent_basis: "first_party",
    },
    checksum: `cksum-imsg-${i}`,
  };
}

function makeScreentimeRow(i, dropMode) {
  // dropMode === "discoverability" -> Stage-0 DROP
  const rc =
    dropMode === "discoverability"
      ? {
          stream: "/discoverability/signals",
          start_date: tsOf(i),
          end_date: tsOf(i),
          focus_mode: null,
          signal: "com.apple.spotlight.indexing",
          os_build: "macOS-25.4",
        }
      : {
          stream: "/app/usage",
          start_date: tsOf(i),
          end_date: tsOf(i),
          focus_mode: "work",
          signal: `com.example.editor.session.${i}`,
          os_build: "macOS-25.4",
          ZTITLE: `Editing memory-system docs ${i}`,
        };
  return {
    id: `ulid_st_${String(i).padStart(8, "0")}`,
    ts: tsOf(i + 100),
    source: "screentime",
    source_msg_id: `screentime:fixture:${i}`,
    parties: ["user"],
    raw_content: rc,
    attachments: [],
    source_policy: {
      deletion_semantics: "full_excise",
      consent_basis: "first_party",
    },
    checksum: `cksum-st-${i}`,
  };
}

function makeGitLogRow(i, dropMode) {
  // dropMode === "initial" -> "Initial commit" -> Stage-0 DROP
  const subject =
    dropMode === "initial"
      ? "Initial commit"
      : `Refactor watermark cursor write path step ${i}`;
  return {
    id: `ulid_git_${String(i).padStart(8, "0")}`,
    ts: tsOf(i + 200),
    source: "git-log",
    source_msg_id: `git:sha-fixture-${i}`,
    parties: ["fixture@example.com"],
    raw_content: {
      repo_path: "/Users/alex/Documents/fixture-repo",
      commit_hash: `sha-fixture-${i}`,
      author_name: "Fixture Dev",
      author_email: "fixture@example.com",
      author_ts: tsOf(i + 200),
      subject,
      parents: i === 0 ? [] : [`sha-fixture-${i - 1}`],
    },
    attachments: [],
    source_policy: {
      deletion_semantics: "full_excise",
      consent_basis: "first_party",
    },
    checksum: `cksum-git-${i}`,
  };
}

function makeGithubEventRow(i, dropMode) {
  // dropMode === "watch" -> WatchEvent -> Stage-0 DROP (low_signal_event)
  const evtType = dropMode === "watch" ? "WatchEvent" : "PullRequestEvent";
  return {
    id: `ulid_gh_${String(i).padStart(8, "0")}`,
    ts: tsOf(i + 300),
    source: "github-events",
    source_msg_id: `gh-event:fixture:${i}`,
    parties: ["user", "gh:fixture-friend"],
    raw_content: {
      event_type: evtType,
      action: "opened",
      pr_number: i,
      pr_title: `Fixture PR title ${i}`,
      pr_author: "fixture-friend",
      repo: "fixture-friend/example-repo",
      public: true,
      created_at: tsOf(i + 300),
    },
    attachments: [],
    source_policy: {
      deletion_semantics: "full_excise",
      consent_basis: "third_party_inferred",
    },
    checksum: `cksum-gh-${i}`,
  };
}

function writeLedger(name, rows) {
  const path = join(SOURCES_DIR, name);
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return path;
}

const ROW_COUNT_PER_SOURCE = 12;
const DROP_ROWS_PER_SOURCE = 2;
const SOURCE_SPECS = [
  { name: "imessage.jsonl", source: "imessage", makeRow: makeImessageRow, dropFlag: "tapback" },
  { name: "screentime.jsonl", source: "screentime", makeRow: makeScreentimeRow, dropFlag: "discoverability" },
  { name: "git-log.jsonl", source: "git-log", makeRow: makeGitLogRow, dropFlag: "initial" },
  { name: "github-events.jsonl", source: "github-events", makeRow: makeGithubEventRow, dropFlag: "watch" },
];

const droppedRowIdsBySource = new Map(); // source -> Set<source_msg_id>
const promotedCandidateIdsBySource = new Map(); // source -> Set<source_msg_id>

for (const spec of SOURCE_SPECS) {
  const rows = [];
  const drops = new Set();
  const promotes = new Set();
  for (let i = 0; i < ROW_COUNT_PER_SOURCE; i++) {
    // First DROP_ROWS_PER_SOURCE row indices = DROP-engineered (Stage-0).
    // Remaining rows PASS Stage-0 → salience PROMOTE branch.
    const isDrop = spec.dropFlag != null && i < DROP_ROWS_PER_SOURCE;
    const row = spec.makeRow(i, isDrop ? spec.dropFlag : null);
    rows.push(row);
    if (isDrop) drops.add(row.source_msg_id);
    else promotes.add(row.source_msg_id);
  }
  writeLedger(spec.name, rows);
  droppedRowIdsBySource.set(spec.source, drops);
  promotedCandidateIdsBySource.set(spec.source, promotes);
}

// ---------------------------------------------------------------------------
// 3. Dynamic imports AFTER env is wired.
// ---------------------------------------------------------------------------
const watermark = await import("../../../daemons/watermark.js");
const recallMod = await import("../../lib/tools/recall.js");
const validationMod = await import("../../lib/validation.js");
const { canonicalJson, CAPS } = validationMod;
const expectedWeightsHash = validationMod.SALIENCE_WEIGHTS_V1_HASH;
const { memoryLedgerPath } = await import("../../lib/config.js");
const recallLogMod = await import("../../lib/recall-log.js");
const policyEventsMod = await import("../../lib/policy-events.js");

const MEMORY_JSONL = memoryLedgerPath();
const RECALL_JSONL = join(LEDGERS_DIR, "recall.jsonl");
const capturedOnlySources = new Set(CAPS.WATERMARK_CAPTURED_ONLY_SOURCES || []);

// ---------------------------------------------------------------------------
// 4. T1 — Watermark → Cascade → memory.jsonl write path.
//
// This is the assertion the R25 bundle silently failed: 163,200 rows decided
// PROMOTE but 0 written. The integration-level surface is "after tick, the
// memory ledger grew". This catches CRIT-1a (missing await), CRIT-1b
// (missing promoteSourceRow export), and CRIT-1c (string vs object content
// adapter) — each independently:
//   - Without await: PROMOTE branch returns before append.
//   - Without export: typeof guard short-circuits past promote.
//   - Without adapter: scoreCandidate throws synchronously on every row.
// ---------------------------------------------------------------------------
const memoryLinesBeforeT1 = readJsonl(MEMORY_JSONL).length;
let tickResult = null;
let tickError = null;
try {
  tickResult = await watermark.tickSourcesOnce({ now: Date.parse("2026-06-02T12:00:00.000Z") });
} catch (e) {
  tickError = e;
}
const memoryLinesAfterT1 = readJsonl(MEMORY_JSONL);
const t1GrowBy = memoryLinesAfterT1.length - memoryLinesBeforeT1;

record(
  "T1 tickSourcesOnce did not throw",
  tickError == null,
  tickError ? `error=${tickError.message}` : null,
);
record(
  "T1 tickSourcesOnce returns a non-null result object",
  tickResult != null && typeof tickResult === "object",
  `tickResult=${JSON.stringify(tickResult)}`,
);
record(
  "T1 memory.jsonl grew (cascade actually appended)",
  t1GrowBy > 0,
  `before=${memoryLinesBeforeT1} after=${memoryLinesAfterT1.length} grew=${t1GrowBy} tick=${JSON.stringify(tickResult)}`,
);

// Every newly-written row MUST carry features.salience (the salience block
// produced by buildSalienceFeaturesBlock and threaded through promoteSourceRow).
const newRows = memoryLinesAfterT1.slice(memoryLinesBeforeT1);
const rowsWithSalience = newRows.filter(
  (r) => r && r.features && typeof r.features.salience === "object" && r.features.salience != null,
);
record(
  "T1 every new memory row carries features.salience",
  newRows.length > 0 && rowsWithSalience.length === newRows.length,
  `new=${newRows.length} with_salience=${rowsWithSalience.length}`,
);

// salience.weights_hash on the written row should match the named export
// SALIENCE_WEIGHTS_V1_HASH (validation.js) — proves the adapter feeds
// scoreCandidate's REAL return through, not a shim.
const rowsWithMatchingHash =
  expectedWeightsHash != null
    ? newRows.filter(
        (r) =>
          r &&
          r.features &&
          r.features.salience &&
          r.features.salience.weights_hash === expectedWeightsHash,
      )
    : newRows;
record(
  "T1 features.salience.weights_hash matches CAPS.SALIENCE_WEIGHTS_V1_HASH",
  expectedWeightsHash == null || rowsWithMatchingHash.length === newRows.length,
  `expected=${expectedWeightsHash} matching=${rowsWithMatchingHash.length}/${newRows.length}`,
);

// ---------------------------------------------------------------------------
// 5. T2 — Per-source PROMOTE counts. Every source must contribute at least
// one promoted row. The R25 bug-mask had 0 across ALL sources; this floor
// catches the "decisioned but never written" regression at the source level.
// ---------------------------------------------------------------------------
const promotedBySource = new Map();
for (const r of newRows) {
  if (!r || !r.source_refs) continue;
  for (const ref of r.source_refs) {
    if (ref && typeof ref.source === "string") {
      const cur = promotedBySource.get(ref.source) || 0;
      promotedBySource.set(ref.source, cur + 1);
    }
  }
}
// Belt-and-braces: some promote paths put the source on the row's top level
// instead of source_refs. Also count by row.source.
for (const r of newRows) {
  if (r && typeof r.source === "string" && !r.source_refs) {
    const cur = promotedBySource.get(r.source) || 0;
    promotedBySource.set(r.source, cur + 1);
  }
}

for (const spec of SOURCE_SPECS) {
  const count = promotedBySource.get(spec.source) || 0;
  if (capturedOnlySources.has(spec.source)) {
    record(
      `T2 source '${spec.source}' is captured-only and promoted 0 rows`,
      count === 0,
      `count=${count} captured_only=${JSON.stringify(Array.from(capturedOnlySources))}`,
    );
    continue;
  }
  record(
    `T2 source '${spec.source}' contributed >=1 promoted row`,
    count >= 1,
    `count=${count} (per-source floor of 1 unmet — repeats the R25 0-write bug)`,
  );
}

// ---------------------------------------------------------------------------
// 6. T3 — caps_snapshot threading on recall.jsonl rows. After R25's
// rerank.js wiring, the recall.js handler should attach a caps_snapshot
// object (containing SALIENCE_WEIGHTS_V1_HASH) onto every persisted recall
// event. The R25 bundle did NOT thread it through; this test fails until
// recall.js:626 reads rerank._capsSnapshot() and writes it.
// ---------------------------------------------------------------------------
const recallLinesBeforeT3 = readJsonl(RECALL_JSONL).length;
const recallArgs = {
  surrounding_context: {
    recent_turns: [{ role: "user", content: "fixture recall query for r25.5 e2e test" }],
    agent_role: "test-agent",
    current_query: "fixture recall query for r25.5 e2e test",
    time: "2026-06-02T12:00:01.000Z",
    ambient: null,
    recent_recall_ids: [],
  },
  conversation_id: "conv_r25p5_e2e_caps_snapshot",
  max_items: 12,
  max_chars: 4000,
};
let recallResult = null;
let recallError = null;
try {
  recallResult = await recallMod.TOOL.handler(recallArgs);
} catch (e) {
  recallError = e;
}
const recallAfter = readJsonl(RECALL_JSONL);
const recallGrowBy = recallAfter.length - recallLinesBeforeT3;
const lastRecall = recallAfter[recallAfter.length - 1] || null;

record(
  "T3 memory_recall handler returns without throwing",
  recallError == null,
  recallError ? `error=${recallError.message}` : null,
);
record(
  "T3 recall.jsonl gained exactly 1 row",
  recallGrowBy === 1,
  `before=${recallLinesBeforeT3} after=${recallAfter.length} grew=${recallGrowBy}`,
);
record(
  "T3 last recall row has caps_snapshot",
  lastRecall != null &&
    lastRecall.caps_snapshot != null &&
    typeof lastRecall.caps_snapshot === "object",
  `caps_snapshot=${lastRecall && JSON.stringify(lastRecall.caps_snapshot).slice(0, 200)}`,
);
record(
  "T3 caps_snapshot.SALIENCE_WEIGHTS_V1_HASH matches CAPS pin",
  lastRecall != null &&
    lastRecall.caps_snapshot != null &&
    lastRecall.caps_snapshot.SALIENCE_WEIGHTS_V1_HASH === expectedWeightsHash,
  `got=${lastRecall && lastRecall.caps_snapshot && lastRecall.caps_snapshot.SALIENCE_WEIGHTS_V1_HASH} expected=${expectedWeightsHash}`,
);

// ---------------------------------------------------------------------------
// 7. T4 — Stage-0 dispatch reaches every source. For each source that has a
// dropping module, the DROP-engineered row must emit a
// policy.salience.dropped event, AND it must NOT show up in memory.jsonl.
//
// This catches the LATENT bug noted in Phase A diagnosis: watermark.js:955
// calls mods.stage0.dispatch but the module exports stage0Dispatch. If the
// guard short-circuits, the DROP-engineered rows would slip through to
// salience scoring where they may still PROMOTE — wrong behavior, and
// recoverable only by surfacing the policy.salience.dropped check.
// ---------------------------------------------------------------------------

// Read every policy-events file in the hermetic POLICY_DIR.
function readPolicyEvents() {
  const monthFiles = readdirSync(POLICY_DIR).filter(
    (n) => n.startsWith("policy-events-") && n.endsWith(".jsonl"),
  );
  const rows = [];
  for (const name of monthFiles) {
    for (const line of readFileSync(join(POLICY_DIR, name), "utf8").split("\n")) {
      if (line === "") continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        // skip
      }
    }
  }
  return rows;
}
const policyEvents = readPolicyEvents();
const droppedEvents = policyEvents.filter(
  (e) => e && e.kind === "policy.salience.dropped",
);
const droppedSources = new Set(droppedEvents.map((e) => e && e.source));

for (const spec of SOURCE_SPECS) {
  if (spec.dropFlag == null) continue; // chat-claude-code has no stage0 drops
  if (capturedOnlySources.has(spec.source)) {
    record(
      `T4 source '${spec.source}' is captured-only and emitted 0 policy.salience.dropped events`,
      !droppedSources.has(spec.source),
      `dropped_events_by_source=${JSON.stringify(Array.from(droppedSources))}`,
    );
    continue;
  }
  record(
    `T4 source '${spec.source}' emitted >=1 policy.salience.dropped event`,
    droppedSources.has(spec.source),
    `dropped_events_by_source=${JSON.stringify(Array.from(droppedSources))}`,
  );
}

// And the DROP-engineered row's source_msg_id must NOT appear in any
// memory.jsonl row's source_refs.
const memorySourceMsgIds = new Set();
for (const r of memoryLinesAfterT1) {
  if (r && Array.isArray(r.source_refs)) {
    for (const ref of r.source_refs) {
      if (ref && typeof ref.source_msg_id === "string") {
        memorySourceMsgIds.add(ref.source_msg_id);
      }
    }
  }
}
for (const spec of SOURCE_SPECS) {
  const expectedDrops = droppedRowIdsBySource.get(spec.source);
  if (!expectedDrops || expectedDrops.size === 0) continue;
  const leaked = Array.from(expectedDrops).filter((id) =>
    memorySourceMsgIds.has(id),
  );
  record(
    `T4 stage-0-dropped rows for '${spec.source}' are absent from memory.jsonl`,
    leaked.length === 0,
    `leaked=${JSON.stringify(leaked)}`,
  );
}

// ---------------------------------------------------------------------------
// 8. T5 — Cursor advance correctness. After tickSourcesOnce:
//   - Per-source cursor exists and reflects the file size (true EOF) — not a
//     made-up value.
//   - A second tick advances no further (idempotent; the read-rows path
//     returns an empty range when start >= snapSize).
// ---------------------------------------------------------------------------
function readCursor(source) {
  const path = join(WATERMARK_STATE_DIR, `${source}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const cursorsAfterFirstTick = new Map();
for (const spec of SOURCE_SPECS) {
  const cur = readCursor(spec.source);
  cursorsAfterFirstTick.set(spec.source, cur);
  const ledgerPath = join(SOURCES_DIR, spec.name);
  const size = existsSync(ledgerPath) ? statSync(ledgerPath).size : -1;
  if (capturedOnlySources.has(spec.source)) {
    record(
      `T5 source '${spec.source}' is captured-only and has no cascade cursor after tick`,
      cur == null,
      `cursor=${JSON.stringify(cur)} size=${size}`,
    );
    continue;
  }
  record(
    `T5 source '${spec.source}' cursor reflects ledger size after tick`,
    cur != null && BigInt(cur.last_offset || "0") === BigInt(size),
    `cursor.last_offset=${cur && cur.last_offset} size=${size}`,
  );
}

// Second tick — must be a no-op for all sources because no new rows have
// been appended.
const memoryLinesBeforeT5b = readJsonl(MEMORY_JSONL).length;
let tick2Error = null;
let tick2Result = null;
try {
  tick2Result = await watermark.tickSourcesOnce({
    now: Date.parse("2026-06-02T12:00:02.000Z"),
  });
} catch (e) {
  tick2Error = e;
}
const memoryLinesAfterT5b = readJsonl(MEMORY_JSONL).length;
record(
  "T5 second tickSourcesOnce did not throw",
  tick2Error == null,
  tick2Error ? `error=${tick2Error.message}` : null,
);
record(
  "T5 second tick is a no-op (memory.jsonl unchanged)",
  memoryLinesBeforeT5b === memoryLinesAfterT5b,
  `before=${memoryLinesBeforeT5b} after=${memoryLinesAfterT5b} tick=${JSON.stringify(tick2Result)}`,
);
for (const spec of SOURCE_SPECS) {
  const beforeOff = cursorsAfterFirstTick.get(spec.source);
  const afterCur = readCursor(spec.source);
  if (capturedOnlySources.has(spec.source)) {
    record(
      `T5 source '${spec.source}' captured-only cursor remains absent after no-op second tick`,
      beforeOff == null && afterCur == null,
      `before=${JSON.stringify(beforeOff)} after=${JSON.stringify(afterCur)}`,
    );
    continue;
  }
  const same =
    beforeOff != null &&
    afterCur != null &&
    String(beforeOff.last_offset) === String(afterCur.last_offset);
  record(
    `T5 source '${spec.source}' cursor unchanged after no-op second tick`,
    same,
    `before=${beforeOff && beforeOff.last_offset} after=${afterCur && afterCur.last_offset}`,
  );
}

// ---------------------------------------------------------------------------
// 9. T6 — Watermark daemon entry-point doesn't throw on reload. The R25
// bundle's watermark daemon crash-looped on launchd reload with
// "TypeError: scoreCandidate: event.content must be a string". This test
// imports the module fresh and asserts neither the import nor tickSourcesOnce
// surfaces a TypeError when fed a synthetic row whose raw_content is an
// object (the production shape). After CRIT-1c lands, scoreCandidate gets a
// .content string courtesy of the adapter; the TypeError must not surface.
//
// We re-import the module in a fresh spawn so the test mirrors the
// launchd-reload sequence (no cached module state).
// ---------------------------------------------------------------------------
const reloadDriver = `
import { tickSourcesOnce } from '${"file://" + WATERMARK_JS}';

try {
  const r = await tickSourcesOnce({ now: Date.parse("2026-06-02T12:00:03.000Z") });
  process.stdout.write("OK " + JSON.stringify(r) + "\\n");
} catch (e) {
  process.stdout.write("THROW " + (e && e.name) + " " + (e && e.message) + "\\n");
  process.exit(2);
}
`;
const reloadDriverPath = join(TMP_ROOT, "reload-driver.mjs");
writeFileSync(reloadDriverPath, reloadDriver);
const reloadProc = spawnSync("node", [reloadDriverPath], {
  env: {
    ...process.env,
    MEMORY_ROOT: HERMETIC_ROOT,
    POLICY_BASE_DIR: POLICY_DIR,
    STORAGE_BASE_DIR: STORAGE_DIR,
    LEDGERS_BASE_DIR: LEDGERS_DIR,
  },
  encoding: "utf8",
  timeout: 30_000,
});
const reloadOk =
  reloadProc.status === 0 &&
  typeof reloadProc.stdout === "string" &&
  reloadProc.stdout.startsWith("OK ");
record(
  "T6 watermark daemon entry-point reload tick exits 0 without TypeError",
  reloadOk,
  `status=${reloadProc.status} stdout=${(reloadProc.stdout || "").slice(0, 240)} stderr=${(reloadProc.stderr || "").slice(0, 240)}`,
);
const reloadStderr = reloadProc.stderr || "";
record(
  "T6 reload tick stderr contains no TypeError or 'event.content must be a string'",
  !/TypeError/.test(reloadStderr) &&
    !/event\.content must be a string/.test(reloadStderr),
  `stderr=${reloadStderr.slice(0, 320)}`,
);

// ---------------------------------------------------------------------------
// 10. Production-snapshot guard.
// ---------------------------------------------------------------------------
const PROD_AFTER = {
  memory: snap(PROD_MEMORY),
  recall: snap(PROD_RECALL),
  indices: snap(PROD_INDICES),
  signing_key: snap(PROD_SIGNING_KEY),
};
const prodUnchanged =
  PROD_AFTER.memory === PROD_BEFORE.memory &&
  PROD_AFTER.recall === PROD_BEFORE.recall &&
  PROD_AFTER.indices === PROD_BEFORE.indices &&
  PROD_AFTER.signing_key === PROD_BEFORE.signing_key;
record(
  "HERMETIC production paths byte-identical pre/post",
  prodUnchanged,
  `memory ${PROD_BEFORE.memory}->${PROD_AFTER.memory} | recall ${PROD_BEFORE.recall}->${PROD_AFTER.recall} | indices ${PROD_BEFORE.indices}->${PROD_AFTER.indices} | signing_key ${PROD_BEFORE.signing_key}->${PROD_AFTER.signing_key}`,
);

// ---------------------------------------------------------------------------
// 11. Cleanup + exit.
// ---------------------------------------------------------------------------
try {
  rmSync(TMP_ROOT, { recursive: true, force: true });
} catch {
  // best-effort
}

if (failures > 0) {
  console.error(`\nFAIL  ${failures} step(s) failed.`);
  process.exit(1);
}
console.log("\nALL PASS  r25-end-to-end-cascade");
