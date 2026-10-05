// project-aggregator.test.mjs — Wave 13 BEHAVIOR coverage for
// F-SYN-BEHAVIOR-project-aggregation.
//
// Mirrors thread-aggregator.test.mjs but for PROJECT-grain synthesis.
//
// N7b NOTE — PRODUCTION SHAPE. The fixtures seed facts in the shape the
// promoter (distill-promote-fact.js) actually writes: a top-level `created_at`
// (NOT `ts`) and repo/author identity forwarded onto `features.thread_keys`
// (NOT a sibling `raw_content` envelope). The pre-N7b fixtures used `ts` +
// sibling `raw_content` — a shape PRODUCTION NEVER WRITES — which is why those
// tests were "green but wrong". These fixtures now exercise FIX-1 (created_at
// resolution) + FIX-2 (features.thread_keys identity) end-to-end.
//
// COVERAGE:
//   T0 — module exports VERSION + frozen CAPS + PROJECT_BEARING_SOURCES
//   T1 — 5 git-log commits, same repo + author + ISO-week → 1 reconstructed
//        with 5 parents (fixture repo: sam-sample/sample-tool)
//   T2 — 1 commit (below MIN_FACTS_PER_PROJECT=2) → not aggregated
//   T3 — 20 commits (above MAX_FACTS_PER_PROJECT=16) → capped at 16
//   T4 — idempotence: re-run on same ledger emits zero new rows
//   T5 — multi-repo: 2 repos with active weeks → 2 distinct reconstructed
//   T6 — cross-author: same repo, different authors → 2 distinct reconstructed
//   T7 — defensive: emitter throw is caught, errors increment, no daemon crash
//   T8 — github-events flows through the same bucketing pipeline as git-log
//   T9 — iMessage facts are NOT bucketed (not in PROJECT_BEARING_SOURCES)
//   T10 — N7b regression: a PRODUCTION-shaped commit (created_at + thread_keys,
//         NO ts, NO raw_content) buckets + emits (proves FIX-1 + FIX-2)
//   T11 — N7b blocker isolation: missing created_at OR identity → no key
//
// Hermetic discipline: env vars set BEFORE any dynamic import so config.js
// binds into TMP_ROOT and the default (production) root stays
// byte-identical.
//
// Run: node --test test/synthesis/project-aggregator.test.mjs

import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";



import { skipIfDaemonActive } from "../_hermetic-daemon-skip.mjs";
skipIfDaemonActive("project-aggregator");

// ---------------------------------------------------------------------------
// 0. Hermetic root + env BEFORE any dynamic import touches config.js.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-w13-projagg-"));
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
  process.env.DAEMONS_BASE_DIR,
  join(process.env.STORAGE_BASE_DIR, "sources"),
]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}

process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// The checkout this suite runs from. Its default (un-overridden) ledgers,
// policy and indices are what the byte-identity guards below watch; the
// suite itself works under a temp MEMORY_ROOT.
const CHECKOUT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
// Production snapshot guard. The project aggregator only reads + appends to
// the memory ledger; we must prove the hermetic root insulates us from the
// real ledgers/memory.jsonl.
const PROD_LEDGER = join(CHECKOUT_ROOT, "ledgers", "memory.jsonl");
function snap(p) {
  try {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "missing";
  }
}
const PROD_BEFORE = snap(PROD_LEDGER);

// ---------------------------------------------------------------------------
// 1. Dynamic imports — bind into TMP_ROOT.
// ---------------------------------------------------------------------------
const aggregatorMod = await import(
  "../../lib/synthesis/project-aggregator.js"
);
const {
  aggregateProjects,
  PROJECT_AGGREGATOR_VERSION,
  PROJECT_AGGREGATOR_CAPS,
  PROJECT_BEARING_SOURCES,
  __internal,
} = aggregatorMod;

const { memoryLedgerPath } = await import("../../lib/config.js");
const LEDGER_PATH = memoryLedgerPath();

// D1 incremental-aggregation deps. The emitter's PIDX cache (flag-ON path) and
// the aggregator's in-process fold state must be reset between flag-ON scenarios
// so a truncate-then-regrow of the shared hermetic ledger (clearLedger keeps the
// SAME inode) can never tail-merge stale bytes. writeCheckpoint lets the test
// play WIRE's role (persist a poisoned offset) to exercise cold-start self-heal.
const { _resetParentIndexCache } = await import(
  "../../lib/synthesis/_parent-index.js"
);
const { writeCheckpoint } = await import(
  "../../lib/synthesis/_agg-checkpoint.js"
);
const {
  resetIncrementalStateForTest,
  getIncrementalStateForTest,
} = __internal;

// Hermetic checkpoint dir (STORAGE_BASE_DIR-derived, design.md §D-1.1). The
// aggregator never WRITES it (WIRE does); resolveStartOffset only READS it at
// cold start, tolerating a missing file (→ offset 0).
const CP_DIR = join(process.env.STORAGE_BASE_DIR, "aggregator-state");
function cpPath(name = "project") {
  return join(CP_DIR, `${name}.json`);
}
const WINDOW = PROJECT_AGGREGATOR_CAPS.TIME_WINDOW_MS;

// Reset BOTH incremental caches + truncate the ledger — a clean slate for a
// flag-ON scenario.
function freshIncremental() {
  resetIncrementalStateForTest();
  _resetParentIndexCache();
  clearLedger();
}

// design.md §D-5.1 normalizer: drop the volatile id/ts, keep the load-bearing
// equivalence key. For plain git/github fixtures contradicts is [] and
// resolution is null on BOTH paths, but we include them so any future
// reconciliation divergence would surface here too.
function recSig(r) {
  return JSON.stringify({
    idempotency_key: r.idempotency_key,
    content: r.content,
    derived_from: [...(r.derived_from || [])].sort(),
    contradicts: [...(r.contradicts || [])].sort(),
    resolution: r.resolution ?? null,
  });
}
function recSigSet() {
  return reconstructedRows()
    .map(recSig)
    .sort();
}

// ---------------------------------------------------------------------------
// 2. Ledger helpers.
// ---------------------------------------------------------------------------
function clearLedger() {
  try {
    writeFileSync(LEDGER_PATH, "", { mode: 0o600 });
  } catch {
    // ENOENT-tolerant: write creates if missing
  }
}

function ledgerLines() {
  if (!existsSync(LEDGER_PATH)) return [];
  const text = readFileSync(LEDGER_PATH, "utf8");
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

function reconstructedRows() {
  return ledgerLines().filter((r) => r && r.kind === "reconstructed");
}

// Fixture identity: one invented contributor (login, address, repo) used for
// both the git-log (repo_path + author_email) and the github-events
// (owner/repo + actor login) project keys.
const OPERATOR_REPO = "/home/alex/code/sam-sample/sample-tool";
const OPERATOR_REPO_GH = "sam-sample/sample-tool";
const OPERATOR_EMAIL = "sam-sample@example.com";
const OPERATOR_LOGIN = "sam-sample";

// Append a synthetic git-log fact directly to the ledger (fixture setup
// only; bypasses the screened MCP surface).
//
// PRODUCTION SHAPE (N7b): `created_at` (NOT a top-level `ts` mirror) + the
// repo/author identity on `features.thread_keys` (the promoter strips
// raw_content and forwards only the closed identity subset).
function seedGitFact({
  id,
  tsIso,
  repoPath,
  authorEmail,
  content,
}) {
  const row = {
    id,
    kind: "fact",
    source: "git-log",
    content,
    source_refs: [
      {
        source: "git-log",
        source_msg_id: `git_${id}`,
        via: "original",
        corroboration_event_id: null,
        consent_basis: "first_party",
      },
    ],
    derived_from: [],
    provenance: {
      agent_id: "test-fixture",
      conversation_id: null,
      confidence: "high",
    },
    // No sibling raw_content — production strips it. Identity (repo_path,
    // author_email) is forwarded onto features.thread_keys (FIX-2 reads this).
    features: {
      entities: [],
      time_anchors: [],
      thread_keys: { repo_path: repoPath, author_email: authorEmail },
    },
    // created_at is authoritative; NO `ts` mirror is seeded so the test PROVES
    // FIX-1 (created_at resolution), not the CASCADE_TS_MIRROR_ENABLED crutch.
    created_at: tsIso,
  };
  appendFileSync(LEDGER_PATH, JSON.stringify(row) + "\n", { mode: 0o600 });
}

function seedGitHubEventFact({
  id,
  tsIso,
  repoFullName,
  actorLogin,
  content,
}) {
  const row = {
    id,
    kind: "fact",
    source: "github-events",
    content,
    source_refs: [
      {
        source: "github-events",
        source_msg_id: `gh-event:${id}`,
        via: "original",
        corroboration_event_id: null,
        consent_basis: "first_party",
      },
    ],
    derived_from: [],
    provenance: {
      agent_id: "test-fixture",
      conversation_id: null,
      confidence: "high",
    },
    features: {
      entities: [],
      time_anchors: [],
      thread_keys: { repo: repoFullName, actor_login: actorLogin },
    },
    created_at: tsIso,
  };
  appendFileSync(LEDGER_PATH, JSON.stringify(row) + "\n", { mode: 0o600 });
}

function seedImessageFact({ id, tsIso, chatIdentifier, content }) {
  const row = {
    id,
    kind: "fact",
    source: "imessage",
    content,
    source_refs: [
      {
        source: "imessage",
        source_msg_id: `imsg_${id}`,
        via: "original",
        corroboration_event_id: null,
        consent_basis: "first_party",
      },
    ],
    derived_from: [],
    provenance: {
      agent_id: "test-fixture",
      conversation_id: null,
      confidence: "high",
    },
    features: {
      entities: [],
      time_anchors: [],
      thread_keys: { chat_guid: chatIdentifier },
    },
    created_at: tsIso,
  };
  appendFileSync(LEDGER_PATH, JSON.stringify(row) + "\n", { mode: 0o600 });
}

// Fixed clock — 2026-06-19 is a Friday, ISO week 2026-W25. Lookback 7d
// covers the whole week. Tests with multiple commits keep them all in this
// same ISO-week bucket so the (repo, author, week) key collapses correctly.
const NOW_ISO = "2026-06-19T12:00:00Z";
const NOW_MS = Date.parse(NOW_ISO);
const EXPECTED_WEEK = "2026-W25";

// ---------------------------------------------------------------------------
// T0 — Module exports (CAPS frozen, VERSION present, sources allowlist).
// ---------------------------------------------------------------------------
test("T0: module exports VERSION + frozen CAPS + PROJECT_BEARING_SOURCES", () => {
  assert.equal(typeof PROJECT_AGGREGATOR_VERSION, "string");
  assert.match(PROJECT_AGGREGATOR_VERSION, /^project-aggregator@/);
  assert.equal(Object.isFrozen(PROJECT_AGGREGATOR_CAPS), true);
  assert.equal(
    PROJECT_AGGREGATOR_CAPS.TIME_WINDOW_MS,
    7 * 24 * 60 * 60 * 1000,
  );
  assert.equal(PROJECT_AGGREGATOR_CAPS.MIN_FACTS_PER_PROJECT, 2);
  assert.equal(PROJECT_AGGREGATOR_CAPS.MAX_FACTS_PER_PROJECT, 16);
  assert.equal(
    PROJECT_AGGREGATOR_CAPS.AGGREGATOR_NAME,
    "daemon:project-aggregator",
  );
  assert.equal(Object.isFrozen(PROJECT_BEARING_SOURCES), true);
  assert.deepEqual([...PROJECT_BEARING_SOURCES], [
    "git-log",
    "github-events",
  ]);
  assert.equal(typeof aggregateProjects, "function");
  assert.equal(typeof __internal.extractProjectKey, "function");
  // isoWeekBucket — 2026-06-19 is Friday, ISO week 2026-W25.
  assert.equal(__internal.isoWeekBucket("2026-06-19T05:23:11Z"), EXPECTED_WEEK);
  // 2026-01-01 is a Thursday, so it falls in ISO week 2026-W01.
  assert.equal(__internal.isoWeekBucket("2026-01-01T00:00:00Z"), "2026-W01");
  assert.equal(__internal.isoWeekBucket("nonsense"), "unknown");
});

// ---------------------------------------------------------------------------
// T1 — 5 commits, same repo + author + week → 1 reconstructed (5 parents).
// Fixture repo: sam-sample/sample-tool.
// ---------------------------------------------------------------------------
test("T1: 5 same-repo same-author same-week git-log facts → 1 reconstructed with 5 parents", async () => {
  clearLedger();
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const id = `fact_git_${i}`;
    ids.push(id);
    seedGitFact({
      id,
      tsIso: `2026-06-19T0${i}:00:00Z`,
      repoPath: OPERATOR_REPO,
      authorEmail: OPERATOR_EMAIL,
      content: `Commit ${i}: scaffold sample-tool feature step ${i}.`,
    });
  }
  const res = await aggregateProjects({
    ledgerPath: LEDGER_PATH,
    sinceMs: PROJECT_AGGREGATOR_CAPS.TIME_WINDOW_MS,
    now: NOW_MS,
  });
  assert.equal(res.projects_processed, 1);
  assert.equal(res.reconstructed_emitted, 1);
  assert.equal(res.errors, 0);

  const recs = reconstructedRows();
  assert.equal(recs.length, 1);
  const rec = recs[0];
  assert.equal(rec.kind, "reconstructed");
  assert.equal(rec.mode, "daemon");
  assert.equal(rec.scope, "cross_session");
  assert.equal(Array.isArray(rec.derived_from), true);
  assert.equal(rec.derived_from.length, 5);
  for (const id of ids) assert.equal(rec.derived_from.includes(id), true);
  assert.match(rec.provenance.agent_id, /^daemon:/);
  assert.equal(rec.provenance.conversation_id, null);
  assert.equal(typeof rec.idempotency_key, "string");
  assert.equal(rec.idempotency_key.length > 0, true);
  assert.equal(typeof rec.content, "string");
  assert.equal(rec.content.length > 0, true);
  assert.equal(
    rec.content.length <= PROJECT_AGGREGATOR_CAPS.CONTENT_SUMMARY_MAX_CHARS,
    true,
  );
});

// ---------------------------------------------------------------------------
// T2 — Below admission floor (1 commit) → not aggregated.
// ---------------------------------------------------------------------------
test("T2: 1 commit (below MIN_FACTS_PER_PROJECT=2) → no reconstructed emitted", async () => {
  clearLedger();
  seedGitFact({
    id: "fact_solo_commit",
    tsIso: "2026-06-19T01:00:00Z",
    repoPath: OPERATOR_REPO,
    authorEmail: OPERATOR_EMAIL,
    content: "Solo commit below admission floor.",
  });
  const res = await aggregateProjects({
    ledgerPath: LEDGER_PATH,
    sinceMs: PROJECT_AGGREGATOR_CAPS.TIME_WINDOW_MS,
    now: NOW_MS,
  });
  assert.equal(res.projects_processed, 0);
  assert.equal(res.reconstructed_emitted, 0);
  assert.equal(res.errors, 0);
  assert.equal(reconstructedRows().length, 0);
});

// ---------------------------------------------------------------------------
// T3 — 20 commits → capped at MAX_FACTS_PER_PROJECT (16).
// ---------------------------------------------------------------------------
test("T3: 20 commits → capped at min(MAX_FACTS_PER_PROJECT, RECONSTRUCT_PARENTS_MAX)", async () => {
  clearLedger();
  for (let i = 0; i < 20; i++) {
    const hour = String(Math.floor(i / 60)).padStart(2, "0");
    const min = String(i % 60).padStart(2, "0");
    seedGitFact({
      id: `fact_cap_${String(i).padStart(2, "0")}`,
      tsIso: `2026-06-19T${hour}:${min}:00Z`,
      repoPath: OPERATOR_REPO,
      authorEmail: OPERATOR_EMAIL,
      content: `Cap-test commit ${i} — refactor module step ${i}.`,
    });
  }
  const res = await aggregateProjects({
    ledgerPath: LEDGER_PATH,
    sinceMs: PROJECT_AGGREGATOR_CAPS.TIME_WINDOW_MS,
    now: NOW_MS,
  });
  assert.equal(res.projects_processed, 1);
  assert.equal(res.reconstructed_emitted, 1);
  assert.equal(res.errors, 0);
  const recs = reconstructedRows();
  assert.equal(recs.length, 1);
  // Cap intersection: min(MAX_FACTS_PER_PROJECT=16, RECONSTRUCT_PARENTS_MAX=16)
  const emitterMod = await import(
    "../../lib/synthesis/reconstruction-emitter.js"
  );
  const expectedCap = Math.min(
    PROJECT_AGGREGATOR_CAPS.MAX_FACTS_PER_PROJECT,
    emitterMod.RECONSTRUCT_PARENTS_MAX,
  );
  assert.equal(recs[0].derived_from.length, expectedCap);
  assert.equal(expectedCap, 16);
});

// ---------------------------------------------------------------------------
// T4 — Idempotence: re-run same ledger → no new reconstructed appended.
// ---------------------------------------------------------------------------
test("T4: re-run on same ledger is idempotent (S5 key match)", async () => {
  clearLedger();
  for (let i = 0; i < 3; i++) {
    seedGitFact({
      id: `fact_idem_${i}`,
      tsIso: `2026-06-19T0${i}:00:00Z`,
      repoPath: OPERATOR_REPO,
      authorEmail: OPERATOR_EMAIL,
      content: `Idempotence-test commit ${i} — stable content for re-run.`,
    });
  }
  const r1 = await aggregateProjects({
    ledgerPath: LEDGER_PATH,
    sinceMs: PROJECT_AGGREGATOR_CAPS.TIME_WINDOW_MS,
    now: NOW_MS,
  });
  assert.equal(r1.projects_processed, 1);
  assert.equal(r1.reconstructed_emitted, 1);
  assert.equal(r1.errors, 0);
  const firstCount = reconstructedRows().length;
  assert.equal(firstCount, 1);

  // Second pass — identical inputs. Should hit the S5 idempotency key and
  // return without appending. dedupe_action=rejected_idempotent does NOT
  // increment reconstructed_emitted (which counts new appends only).
  const r2 = await aggregateProjects({
    ledgerPath: LEDGER_PATH,
    sinceMs: PROJECT_AGGREGATOR_CAPS.TIME_WINDOW_MS,
    now: NOW_MS,
  });
  assert.equal(r2.projects_processed, 1);
  assert.equal(r2.reconstructed_emitted, 0);
  assert.equal(r2.errors, 0);
  assert.equal(reconstructedRows().length, firstCount);
});

// ---------------------------------------------------------------------------
// T5 — Multi-repo: 2 distinct repos with active weeks → 2 reconstructed.
// ---------------------------------------------------------------------------
test("T5: multi-repo (2 distinct repos) → 2 distinct reconstructed rows", async () => {
  clearLedger();
  const repoA = OPERATOR_REPO;
  const repoB = "/home/alex/code/sam-sample/other-project";
  for (let i = 0; i < 3; i++) {
    seedGitFact({
      id: `fact_multi_a_${i}`,
      tsIso: `2026-06-19T0${i}:00:00Z`,
      repoPath: repoA,
      authorEmail: OPERATOR_EMAIL,
      content: `RepoA commit ${i}: feature step ${i}.`,
    });
  }
  // All 4 commits strictly BEFORE now (12:00Z) so every one survives the
  // stream filter's upper bound — the pre-N7b fixture put the 4th at 13:00
  // (FUTURE), which the window dropped, making the test a known flake.
  for (let i = 0; i < 4; i++) {
    seedGitFact({
      id: `fact_multi_b_${i}`,
      tsIso: `2026-06-19T0${i + 4}:00:00Z`,
      repoPath: repoB,
      authorEmail: OPERATOR_EMAIL,
      content: `RepoB commit ${i}: refactor module step ${i}.`,
    });
  }
  const res = await aggregateProjects({
    ledgerPath: LEDGER_PATH,
    sinceMs: PROJECT_AGGREGATOR_CAPS.TIME_WINDOW_MS,
    now: NOW_MS,
  });
  assert.equal(res.projects_processed, 2);
  assert.equal(res.reconstructed_emitted, 2);
  assert.equal(res.errors, 0);
  const recs = reconstructedRows();
  assert.equal(recs.length, 2);
  const parentCounts = recs.map((r) => r.derived_from.length).sort();
  assert.deepEqual(parentCounts, [3, 4]);
  // Distinct idempotency keys per S5 (bucket_key differs by repo).
  assert.notEqual(recs[0].idempotency_key, recs[1].idempotency_key);
});

// ---------------------------------------------------------------------------
// T6 — Cross-author: same repo + week, different authors → 2 reconstructed.
// ---------------------------------------------------------------------------
test("T6: cross-author (same repo, 2 authors) → 2 distinct reconstructed rows", async () => {
  clearLedger();
  const repo = OPERATOR_REPO;
  const authorA = OPERATOR_EMAIL;
  const authorB = "collab@example.com";
  for (let i = 0; i < 3; i++) {
    seedGitFact({
      id: `fact_cross_a_${i}`,
      tsIso: `2026-06-19T0${i}:00:00Z`,
      repoPath: repo,
      authorEmail: authorA,
      content: `AuthorA commit ${i}: planning + scaffolding.`,
    });
  }
  for (let i = 0; i < 3; i++) {
    seedGitFact({
      id: `fact_cross_b_${i}`,
      tsIso: `2026-06-19T1${i}:00:00Z`,
      repoPath: repo,
      authorEmail: authorB,
      content: `AuthorB commit ${i}: tests + docs.`,
    });
  }
  const res = await aggregateProjects({
    ledgerPath: LEDGER_PATH,
    sinceMs: PROJECT_AGGREGATOR_CAPS.TIME_WINDOW_MS,
    now: NOW_MS,
  });
  assert.equal(res.projects_processed, 2);
  assert.equal(res.reconstructed_emitted, 2);
  assert.equal(res.errors, 0);
  const recs = reconstructedRows();
  assert.equal(recs.length, 2);
  // Each author owns 3 parents.
  for (const r of recs) {
    assert.equal(r.derived_from.length, 3);
  }
  assert.notEqual(recs[0].idempotency_key, recs[1].idempotency_key);
});

// ---------------------------------------------------------------------------
// T7 — Defensive: synthetic emitter throw via throwing `now` injector.
// The emitter's assembleRow calls nowFn(); a throwing nowFn forces the
// aggregator's catch path to bump errors and continue without crashing the
// daemon's idle tick.
// ---------------------------------------------------------------------------
test("T7: defensive — emitter throw is caught, errors increment, no crash", async () => {
  clearLedger();
  for (let i = 0; i < 3; i++) {
    seedGitFact({
      id: `fact_throw_${i}`,
      tsIso: `2026-06-19T0${i}:00:00Z`,
      repoPath: OPERATOR_REPO,
      authorEmail: OPERATOR_EMAIL,
      content: `Throw-test commit ${i} — content content content.`,
    });
  }
  const errors = [];
  const logger = { error: (m) => errors.push(String(m)) };
  const throwingNow = () => {
    throw new Error("synthetic now() failure");
  };
  const res = await aggregateProjects({
    ledgerPath: LEDGER_PATH,
    sinceMs: PROJECT_AGGREGATOR_CAPS.TIME_WINDOW_MS,
    now: NOW_MS,
    emitterCtx: { now: throwingNow, logger },
  });
  assert.equal(res.projects_processed, 1);
  assert.equal(res.reconstructed_emitted, 0);
  assert.equal(res.errors, 1);
  assert.equal(errors.length > 0, true);
  // Aggregator returned a structured envelope rather than crashing — the
  // daemon-side contract is preserved.
  assert.equal(typeof res, "object");
  // No reconstructed rows appended.
  assert.equal(reconstructedRows().length, 0);
});

// ---------------------------------------------------------------------------
// T8 — github-events flow through the same pipeline. We seed
// github-events rows whose raw_content uses {repo, actor_login} (the
// shape the connector writes) and prove the aggregator buckets them.
// ---------------------------------------------------------------------------
test("T8: github-events facts bucket on {repo, actor_login, week} → 1 reconstructed", async () => {
  clearLedger();
  for (let i = 0; i < 3; i++) {
    seedGitHubEventFact({
      id: `fact_gh_${i}`,
      tsIso: `2026-06-19T0${i}:00:00Z`,
      repoFullName: OPERATOR_REPO_GH,
      actorLogin: OPERATOR_LOGIN,
      content: `GitHub event ${i}: PushEvent on sample-tool.`,
    });
  }
  const res = await aggregateProjects({
    ledgerPath: LEDGER_PATH,
    sinceMs: PROJECT_AGGREGATOR_CAPS.TIME_WINDOW_MS,
    now: NOW_MS,
  });
  assert.equal(res.projects_processed, 1);
  assert.equal(res.reconstructed_emitted, 1);
  assert.equal(res.errors, 0);
  const recs = reconstructedRows();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].derived_from.length, 3);
  // bucket_key contains the github repo + login + ISO week.
  // (We exercise the extractor directly to confirm key shape.)
  const probe = __internal.extractProjectKey({
    id: "probe",
    ts: "2026-06-19T00:00:00Z",
    kind: "fact",
    source: "github-events",
    content: "x",
    raw_content: {
      repo: OPERATOR_REPO_GH,
      actor_login: OPERATOR_LOGIN,
    },
  });
  assert.notEqual(probe, null);
  assert.equal(probe.week, EXPECTED_WEEK);
  assert.equal(
    probe.bucket_key,
    `repo:${OPERATOR_REPO_GH}:author:login:${OPERATOR_LOGIN}:week:${EXPECTED_WEEK}`,
  );
});

// ---------------------------------------------------------------------------
// T9 — Scope guard: iMessage facts are NOT in PROJECT_BEARING_SOURCES, so
// even with 10 same-chat messages the project aggregator emits zero
// reconstructed rows. The thread-aggregator owns iMessage; this confirms
// the two aggregators have disjoint source domains.
// ---------------------------------------------------------------------------
test("T9: iMessage facts are NOT bucketed by project aggregator", async () => {
  clearLedger();
  for (let i = 0; i < 10; i++) {
    seedImessageFact({
      id: `fact_imsg_scope_${i}`,
      tsIso: `2026-06-19T0${i}:00:00Z`,
      chatIdentifier: "+15551234567",
      content: `Message ${i}: outside the project aggregator's scope.`,
    });
  }
  const res = await aggregateProjects({
    ledgerPath: LEDGER_PATH,
    sinceMs: PROJECT_AGGREGATOR_CAPS.TIME_WINDOW_MS,
    now: NOW_MS,
  });
  assert.equal(res.projects_processed, 0);
  assert.equal(res.reconstructed_emitted, 0);
  assert.equal(res.errors, 0);
  assert.equal(reconstructedRows().length, 0);
  // extractProjectKey explicitly returns null for non-project sources.
  const probe = __internal.extractProjectKey({
    id: "probe",
    ts: "2026-06-19T00:00:00Z",
    kind: "fact",
    source: "imessage",
    content: "x",
    raw_content: { chat_identifier: "+15551234567" },
  });
  assert.equal(probe, null);
});

// ---------------------------------------------------------------------------
// T10 — N7b REGRESSION: a fully PRODUCTION-shaped commit (created_at + identity
// on features.thread_keys, NO top-level ts, NO sibling raw_content) buckets and
// emits. This is the exact shape that emitted ZERO reconstructed rows before
// N7b. Proves FIX-1 (created_at resolution) + FIX-2 (thread_keys identity). The
// on-disk shape is asserted explicitly so a regression to the production-never
// ts+raw_content fixture can never silently reopen.
// ---------------------------------------------------------------------------
test("T10: production-shaped commit (created_at + thread_keys, no ts/raw_content) emits", async () => {
  clearLedger();
  for (let i = 0; i < 3; i++) {
    seedGitFact({
      id: `fact_prodshape_${i}`,
      tsIso: `2026-06-19T0${i}:30:00Z`,
      repoPath: OPERATOR_REPO,
      authorEmail: OPERATOR_EMAIL,
      content: `Prod-shape commit ${i}: implement feature step ${i}.`,
    });
  }
  const seeded = ledgerLines().filter(
    (r) => r && r.kind === "fact" && typeof r.id === "string" && r.id.startsWith("fact_prodshape_"),
  );
  assert.equal(seeded.length, 3);
  for (const f of seeded) {
    assert.equal("ts" in f, false, "production fact carries NO top-level ts mirror");
    assert.equal("raw_content" in f, false, "production fact carries NO sibling raw_content");
    assert.equal(typeof f.created_at, "string", "production fact carries created_at");
    assert.equal(typeof f.features.thread_keys, "object");
    assert.equal(f.features.thread_keys.repo_path, OPERATOR_REPO);
    assert.equal(f.features.thread_keys.author_email, OPERATOR_EMAIL);
  }

  const res = await aggregateProjects({
    ledgerPath: LEDGER_PATH,
    sinceMs: PROJECT_AGGREGATOR_CAPS.TIME_WINDOW_MS,
    now: NOW_MS,
  });
  // THE CORE N7b GATE: a production-shaped project emits ≥1 reconstructed row.
  assert.equal(res.projects_processed, 1);
  assert.equal(res.reconstructed_emitted, 1);
  assert.equal(res.errors, 0);
  const recs = reconstructedRows();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].derived_from.length, 3);
  assert.match(recs[0].idempotency_key, /\S/);
});

// ---------------------------------------------------------------------------
// T11 — N7b BLOCKER ISOLATION. Each fix is independently load-bearing at the
// key-extraction boundary:
//   (a) a commit with NO created_at and NO ts → resolveRowTs null → no key.
//   (b) a commit with created_at but NO identity (thread_keys/raw_content) → no
//       key (FIX-2 finds nothing to bucket on).
// ---------------------------------------------------------------------------
test("T11: blocker isolation — missing created_at OR identity yields no bucket key", () => {
  const { extractProjectKey, resolveRowTs } = __internal;
  // resolveRowTs: ts wins, then created_at, else null.
  assert.equal(resolveRowTs({ id: "x", source: "git-log" }), null);
  assert.equal(resolveRowTs({ ts: "2026-06-19T00:00:00Z" }), "2026-06-19T00:00:00Z");
  assert.equal(
    resolveRowTs({ created_at: "2026-06-19T00:00:00Z" }),
    "2026-06-19T00:00:00Z",
  );
  assert.equal(
    resolveRowTs({ ts: "2026-06-19T01:00:00Z", created_at: "2026-06-19T09:00:00Z" }),
    "2026-06-19T01:00:00Z",
  );
  // (a) identity present but no timestamp → null key.
  assert.equal(
    extractProjectKey({
      id: "x",
      kind: "fact",
      source: "git-log",
      content: "c",
      features: { thread_keys: { repo_path: "/r", author_email: "a@example.com" } },
    }),
    null,
    "no created_at/ts → null key even WITH identity",
  );
  // (b) created_at present but no identity → null key.
  assert.equal(
    extractProjectKey({
      id: "y",
      kind: "fact",
      source: "git-log",
      content: "c",
      created_at: "2026-06-19T00:00:00Z",
      features: { entities: [] },
    }),
    null,
    "created_at WITHOUT identity → null key",
  );
  // Both present → a resolvable key (the post-fix happy path), threading on
  // features.thread_keys with the created_at week bucket.
  const k = extractProjectKey({
    id: "z",
    kind: "fact",
    source: "git-log",
    content: "c",
    created_at: "2026-06-19T00:00:00Z",
    features: { thread_keys: { repo_path: "/r", author_email: "a@example.com" } },
  });
  assert.notEqual(k, null);
  assert.equal(k.week, EXPECTED_WEEK);
  assert.equal(k.bucket_key, `repo:/r:author:email:a@example.com:week:${EXPECTED_WEEK}`);
});

// ===========================================================================
// D1 INCREMENTAL (flag-ON) COVERAGE.
//
// The load-bearing invariant: flag-ON emits the IDENTICAL reconstructed rows as
// flag-OFF (full-rescan) on the same ledger snapshot at the same `now`. Every
// flag-ON test resets the in-process fold state + the emitter PIDX cache first
// (freshIncremental) so the shared hermetic ledger cannot leak state across
// scenarios. checkpointPath is always a hermetic tmp path.
// ===========================================================================

// Seed closures (reused for OFF and ON passes of the equivalence test). Each
// returns the seeded fact ids.
function seedProjectFixture(kind) {
  if (kind === "single") {
    // T1-shape: 5 git commits, same repo+author+week → 1 rec (5 parents).
    for (let i = 0; i < 5; i++) {
      seedGitFact({
        id: `eq_single_${i}`,
        tsIso: `2026-06-19T0${i}:00:00Z`,
        repoPath: OPERATOR_REPO,
        authorEmail: OPERATOR_EMAIL,
        content: `Commit ${i}: scaffold sample-tool feature step ${i}.`,
      });
    }
  } else if (kind === "cap") {
    // T3-shape: 20 commits → capped at 16.
    for (let i = 0; i < 20; i++) {
      const hour = String(Math.floor(i / 60)).padStart(2, "0");
      const mm = String(i % 60).padStart(2, "0");
      seedGitFact({
        id: `eq_cap_${String(i).padStart(2, "0")}`,
        tsIso: `2026-06-19T${hour}:${mm}:00Z`,
        repoPath: OPERATOR_REPO,
        authorEmail: OPERATOR_EMAIL,
        content: `Cap-test commit ${i} — refactor module step ${i}.`,
      });
    }
  } else if (kind === "idem") {
    // T4-shape: 3 commits.
    for (let i = 0; i < 3; i++) {
      seedGitFact({
        id: `eq_idem_${i}`,
        tsIso: `2026-06-19T0${i}:00:00Z`,
        repoPath: OPERATOR_REPO,
        authorEmail: OPERATOR_EMAIL,
        content: `Idempotence commit ${i} — stable content.`,
      });
    }
  } else if (kind === "multirepo") {
    // T5-shape: 3 + 4 across two repos.
    const repoB = "/home/alex/code/sam-sample/other-project";
    for (let i = 0; i < 3; i++) {
      seedGitFact({
        id: `eq_mr_a_${i}`,
        tsIso: `2026-06-19T0${i}:00:00Z`,
        repoPath: OPERATOR_REPO,
        authorEmail: OPERATOR_EMAIL,
        content: `RepoA commit ${i}: feature step ${i}.`,
      });
    }
    for (let i = 0; i < 4; i++) {
      seedGitFact({
        id: `eq_mr_b_${i}`,
        tsIso: `2026-06-19T0${i + 4}:00:00Z`,
        repoPath: repoB,
        authorEmail: OPERATOR_EMAIL,
        content: `RepoB commit ${i}: refactor module step ${i}.`,
      });
    }
  } else if (kind === "crossauthor") {
    // T6-shape: same repo, two authors, 3 each.
    for (let i = 0; i < 3; i++) {
      seedGitFact({
        id: `eq_ca_a_${i}`,
        tsIso: `2026-06-19T0${i}:00:00Z`,
        repoPath: OPERATOR_REPO,
        authorEmail: OPERATOR_EMAIL,
        content: `AuthorA commit ${i}: planning + scaffolding.`,
      });
    }
    for (let i = 0; i < 3; i++) {
      seedGitFact({
        id: `eq_ca_b_${i}`,
        tsIso: `2026-06-19T1${i}:00:00Z`,
        repoPath: OPERATOR_REPO,
        authorEmail: "collab@example.com",
        content: `AuthorB commit ${i}: tests + docs.`,
      });
    }
  } else if (kind === "github") {
    // T8-shape: 3 github-events.
    for (let i = 0; i < 3; i++) {
      seedGitHubEventFact({
        id: `eq_gh_${i}`,
        tsIso: `2026-06-19T0${i}:00:00Z`,
        repoFullName: OPERATOR_REPO_GH,
        actorLogin: OPERATOR_LOGIN,
        content: `GitHub event ${i}: PushEvent on sample-tool.`,
      });
    }
  }
}

async function assertOnEquivOff(kind) {
  // Flag-OFF pass → capture the normalized reconstructed sig set.
  freshIncremental();
  seedProjectFixture(kind);
  const off = await aggregateProjects({
    ledgerPath: LEDGER_PATH,
    sinceMs: WINDOW,
    now: NOW_MS,
  });
  const offSet = recSigSet();

  // Flag-ON pass over a fresh, IDENTICAL ledger + same `now`.
  freshIncremental();
  seedProjectFixture(kind);
  const on = await aggregateProjects({
    ledgerPath: LEDGER_PATH,
    sinceMs: WINDOW,
    now: NOW_MS,
    incremental: true,
    checkpointPath: cpPath(),
  });
  const onSet = recSigSet();

  assert.deepEqual(
    onSet,
    offSet,
    `flag-ON≡flag-OFF reconstructed sig mismatch (${kind})`,
  );
  assert.equal(
    on.projects_processed,
    off.projects_processed,
    `projects_processed (${kind})`,
  );
  assert.equal(
    on.reconstructed_emitted,
    off.reconstructed_emitted,
    `reconstructed_emitted (${kind})`,
  );
  assert.equal(on.errors, off.errors, `errors (${kind})`);
  // Both paths must actually emit ≥1 rec (guards against a vacuous pass).
  assert.equal(off.reconstructed_emitted > 0, true, `off emitted (${kind})`);
}

// ---------------------------------------------------------------------------
// T12 — EQUIVALENCE: flag-ON emits byte-identical reconstructed rows to
// flag-OFF on the T1/T3/T4/T5/T6/T8 fixtures.
// ---------------------------------------------------------------------------
test("T12: flag-ON ≡ flag-OFF on single-project (T1) fixture", async () => {
  await assertOnEquivOff("single");
});
test("T12b: flag-ON ≡ flag-OFF on cap (T3, 20→16) fixture", async () => {
  await assertOnEquivOff("cap");
});
test("T12c: flag-ON ≡ flag-OFF on idempotence (T4) fixture", async () => {
  await assertOnEquivOff("idem");
});
test("T12d: flag-ON ≡ flag-OFF on multi-repo (T5) fixture", async () => {
  await assertOnEquivOff("multirepo");
});
test("T12e: flag-ON ≡ flag-OFF on cross-author (T6) fixture", async () => {
  await assertOnEquivOff("crossauthor");
});
test("T12f: flag-ON ≡ flag-OFF on github-events (T8) fixture", async () => {
  await assertOnEquivOff("github");
});

// ---------------------------------------------------------------------------
// T13 — INCREMENTAL ADVANCE: cold run scans the whole ledger; a warm run after
// appending K facts scans ONLY the appended bytes (not the whole ~1.9GB ledger).
// ---------------------------------------------------------------------------
test("T13: flag-ON warm run scans only the appended bytes (offset advance)", async () => {
  freshIncremental();
  for (let i = 0; i < 3; i++) {
    seedGitFact({
      id: `adv_${i}`,
      tsIso: `2026-06-19T0${i}:00:00Z`,
      repoPath: OPERATOR_REPO,
      authorEmail: OPERATOR_EMAIL,
      content: `Advance commit ${i} — initial batch.`,
    });
  }
  const sizeA = statSync(LEDGER_PATH).size;
  const r1 = await aggregateProjects({
    ledgerPath: LEDGER_PATH,
    sinceMs: WINDOW,
    now: NOW_MS,
    incremental: true,
    checkpointPath: cpPath(),
  });
  // Cold run: whole ledger scanned; offset lands at the pre-emit EOF.
  assert.equal(r1.reconstructed_emitted, 1);
  assert.equal(r1.checkpoint_offset, sizeA);
  assert.equal(r1.bytes_scanned, sizeA);

  // Append 2 MORE facts into the same (repo, author, week) bucket.
  for (let i = 3; i < 5; i++) {
    seedGitFact({
      id: `adv_${i}`,
      tsIso: `2026-06-19T0${i}:00:00Z`,
      repoPath: OPERATOR_REPO,
      authorEmail: OPERATOR_EMAIL,
      content: `Advance commit ${i} — appended batch.`,
    });
  }
  const sizeB = statSync(LEDGER_PATH).size;
  const r2 = await aggregateProjects({
    ledgerPath: LEDGER_PATH,
    sinceMs: WINDOW,
    now: NOW_MS,
    incremental: true,
    checkpointPath: cpPath(),
  });
  // Warm run: folded EXACTLY [sizeA, sizeB) — the appended bytes only (which
  // include r1's own reconstructed row, skipped by the kind gate).
  assert.equal(r2.bytes_scanned, sizeB - sizeA);
  assert.equal(r2.checkpoint_offset, sizeB);
  assert.equal(r2.bytes_scanned < sizeB, true, "did NOT rescan the whole ledger");
  // Bucket grew 3→5 facts → content changed → a NEW reconstructed row.
  assert.equal(r2.reconstructed_emitted, 1);
  assert.equal(reconstructedRows().length, 2);
});

// ---------------------------------------------------------------------------
// T14 — CROSS-RUN IDEMPOTENCE: a second flag-ON run with no new appends emits
// zero new rows (S5 idempotency key) while still processing the live bucket.
// ---------------------------------------------------------------------------
test("T14: flag-ON second run with no new facts emits 0 new rows", async () => {
  freshIncremental();
  for (let i = 0; i < 3; i++) {
    seedGitFact({
      id: `idemrun_${i}`,
      tsIso: `2026-06-19T0${i}:00:00Z`,
      repoPath: OPERATOR_REPO,
      authorEmail: OPERATOR_EMAIL,
      content: `Idem-run commit ${i} — stable content.`,
    });
  }
  const r1 = await aggregateProjects({
    ledgerPath: LEDGER_PATH,
    sinceMs: WINDOW,
    now: NOW_MS,
    incremental: true,
    checkpointPath: cpPath(),
  });
  assert.equal(r1.reconstructed_emitted, 1);
  const after1 = reconstructedRows().length;
  assert.equal(after1, 1);

  const r2 = await aggregateProjects({
    ledgerPath: LEDGER_PATH,
    sinceMs: WINDOW,
    now: NOW_MS,
    incremental: true,
    checkpointPath: cpPath(),
  });
  assert.equal(r2.projects_processed, 1); // bucket still live + processed
  assert.equal(r2.reconstructed_emitted, 0); // S5 idempotent → no append
  assert.equal(r2.errors, 0);
  assert.equal(reconstructedRows().length, after1); // no new row on disk
});

// ---------------------------------------------------------------------------
// T15 — SELF-HEAL (truncate): a stale in-process offset PAST the current EOF
// (ledger truncated/rebuilt-smaller under the daemon) drops the stale state,
// resets the offset to 0, and re-folds correctly (design.md §D-1.4a / §D-3.4).
// ---------------------------------------------------------------------------
test("T15: flag-ON self-heals when the persisted offset is past EOF", async () => {
  freshIncremental();
  for (let i = 0; i < 3; i++) {
    seedGitFact({
      id: `heal_${i}`,
      tsIso: `2026-06-19T0${i}:00:00Z`,
      repoPath: OPERATOR_REPO,
      authorEmail: OPERATOR_EMAIL,
      content: `Heal commit ${i} — first generation.`,
    });
  }
  const r1 = await aggregateProjects({
    ledgerPath: LEDGER_PATH,
    sinceMs: WINDOW,
    now: NOW_MS,
    incremental: true,
    checkpointPath: cpPath(),
  });
  assert.equal(r1.reconstructed_emitted, 1);
  const st1 = getIncrementalStateForTest(LEDGER_PATH);
  assert.equal(st1.offset > 0, true);

  // Truncate the ledger under us (clearLedger keeps the SAME inode, size→0).
  // Do NOT reset the incremental state — the STALE offset must trigger the
  // in-process self-heal (state.offset > ledgerSize).
  clearLedger();
  _resetParentIndexCache();
  const r2 = await aggregateProjects({
    ledgerPath: LEDGER_PATH,
    sinceMs: WINDOW,
    now: NOW_MS,
    incremental: true,
    checkpointPath: cpPath(),
  });
  assert.equal(r2.projects_processed, 0);
  assert.equal(r2.reconstructed_emitted, 0);
  assert.equal(r2.checkpoint_offset, 0, "offset reset to 0 on self-heal");
  const st2 = getIncrementalStateForTest(LEDGER_PATH);
  assert.equal(st2.offset, 0);
  assert.equal(st2.buckets.size, 0, "stale buckets dropped");

  // Re-seed a fresh generation → the next (warm-from-0) run re-folds + emits.
  for (let i = 0; i < 3; i++) {
    seedGitFact({
      id: `heal2_${i}`,
      tsIso: `2026-06-19T0${i}:00:00Z`,
      repoPath: OPERATOR_REPO,
      authorEmail: OPERATOR_EMAIL,
      content: `Heal commit ${i} — second generation.`,
    });
  }
  const r3 = await aggregateProjects({
    ledgerPath: LEDGER_PATH,
    sinceMs: WINDOW,
    now: NOW_MS,
    incremental: true,
    checkpointPath: cpPath(),
  });
  assert.equal(r3.reconstructed_emitted, 1);
  assert.equal(reconstructedRows().length, 1);
});

// ---------------------------------------------------------------------------
// T16 — COLD-START DISK SELF-HEAL: a poisoned persisted checkpoint (last_offset
// far past EOF) is rejected by CKPT (resolveStartOffset → 0), and the
// authoritative window-rescan still emits the correct rows regardless.
// ---------------------------------------------------------------------------
test("T16: flag-ON cold start rejects a poisoned checkpoint (resume_offset=0) and still emits", async () => {
  freshIncremental();
  for (let i = 0; i < 3; i++) {
    seedGitFact({
      id: `poison_${i}`,
      tsIso: `2026-06-19T0${i}:00:00Z`,
      repoPath: OPERATOR_REPO,
      authorEmail: OPERATOR_EMAIL,
      content: `Poison-checkpoint commit ${i}.`,
    });
  }
  const ledgerSize = statSync(LEDGER_PATH).size;
  const poison = cpPath("poison");
  const ok = writeCheckpoint(poison, ledgerSize + 1_000_000, {
    aggregator: "project",
  });
  assert.equal(ok, true);

  // Fresh in-process state → cold start reads the poisoned checkpoint.
  resetIncrementalStateForTest();
  _resetParentIndexCache();
  const r = await aggregateProjects({
    ledgerPath: LEDGER_PATH,
    sinceMs: WINDOW,
    now: NOW_MS,
    incremental: true,
    checkpointPath: poison,
  });
  // CKPT self-heal: stored offset > live ledger size → safe start 0.
  assert.equal(r.resume_offset, 0);
  // Window-rescan is authoritative → correct emit despite the poisoned offset.
  assert.equal(r.reconstructed_emitted, 1);
  assert.equal(r.checkpoint_offset, ledgerSize);
  assert.equal(reconstructedRows().length, 1);
});

// Clean the incremental caches so the ZZ production guard + any later suite
// start from a neutral module state.
test("T17: incremental caches reset (housekeeping)", () => {
  resetIncrementalStateForTest();
  _resetParentIndexCache();
  assert.equal(getIncrementalStateForTest(LEDGER_PATH), null);
});

// ---------------------------------------------------------------------------
// PRODUCTION SNAPSHOT GUARD — no real-world ledger mutation.
// ---------------------------------------------------------------------------
test("ZZ: production ledger untouched (hermetic guard)", () => {
  const after = snap(PROD_LEDGER);
  assert.equal(
    after,
    PROD_BEFORE,
    `production ledger mutated during W13 project-aggregator tests: before=${PROD_BEFORE} after=${after}`,
  );
});
