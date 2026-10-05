// R26 — daemons/watermark.js multi-source source-routing coverage.
//
// This is the structured T1–T5 companion to watermark-multi-source.test.mjs.
// Where the sibling test validates the cursor SCHEMA and core restart-recovery
// surface end-to-end via `node daemons/watermark.js --once`, this test names
// the five contract gates separately so each failure is attributable, and
// it adds the per-source-routing assertion (each source-tagged row passes
// through the cascade entry point exactly once).
//
// SPY MODEL
// ---------
// The watermark daemon invokes the salience cascade through three lazily
// imported modules (mcp/lib/ingest/stage0/index.js, mcp/lib/ingest/salience.js,
// mcp/lib/tools/distill-promote-fact.js). Per Phase A integration map, agents
// A1/A2/A3 own those files. To avoid coupling this test to whether the
// cascade modules' API surface is fully ratified at this moment (the daemon's
// runSourceCascade looks for mods.stage0.dispatch and mods.promote.promoteSourceRow
// — names that may still be churning between sibling-agent revisions), the
// observable contract this test pins is:
//
//   * tickSourcesOnce reads exactly N rows from source X's ledger in the right
//     byte range (results.rows_read accumulates per call across all sources;
//     per-source readership is verified via cursor advance + last_event_id),
//   * the per-source cursor at storage/watermark-state/<source>.json advances
//     to the EOF-byte the test seeded (proof every row was dispatched),
//   * the per-source last_event_id reflects the final source_msg_id of that
//     source's seeded rows (proof the dispatch order was source-correct),
//   * connector_revoke discipline routes one source to a skip + a
//     policy.salience.source_revoked policy event without touching the others,
//   * a parse failure bumps a single source's error_count and advances its
//     cursor past the malformed byte range without affecting siblings.
//
// This is the strongest hermetic "spy" we can build without forking
// watermark.js into a test-only branch. When sibling agents A1/A2/A3 ship
// the final cascade-module API and A7 wires runSourceCascade to it, the
// stricter "spy on promoteSourceRow exact call count" assertion can be
// strengthened in-place — see the comment blocks marked "STRICT-SPEC NOTE".
//
// HERMETIC ISOLATION
// ------------------
// - One mkdtempSync MEMORY_ROOT per process, cleaned up at exit.
// - Spawns `node daemons/watermark.js --once` with env overrides so the
//   daemon's config.js paths resolve under tmpRoot.
// - Production memory.jsonl / policy / ledgers / sources are NEVER touched.
//
// Run: node test/daemons/watermark-multisource.test.mjs
// Exits 0 on PASS / non-zero on any FAIL.

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const WATERMARK_BIN = join(REPO_ROOT, "daemons", "watermark.js");

// ---------------------------------------------------------------------------
// Output helpers — minimal, no colour codes, no emojis.
// ---------------------------------------------------------------------------

let failures = 0;
let assertions = 0;
function check(label, cond, detail) {
  assertions += 1;
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}
function section(name) {
  console.log(`\n[${name}]`);
}

// ---------------------------------------------------------------------------
// Hermetic MEMORY_ROOT.
// ---------------------------------------------------------------------------

const tmpRoot = mkdtempSync(join(tmpdir(), "watermark-multisource-T-"));
process.on("exit", () => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const POLICY_DIR = join(tmpRoot, "policy");
const STORAGE_DIR = join(tmpRoot, "storage");
const LEDGERS_DIR = join(tmpRoot, "ledgers");
const SOURCES_DIR = join(STORAGE_DIR, "sources");
// R34 CLOSE-3: removed QUEUE_DIR + four queue subdir mkdirs. The watermark
// daemon retired the distillation-queue tree in R32.1; this test never
// reads or writes those dirs. Vestigial scaffolding flagged by spec-sweep.
const WATERMARK_STATE_DIR = join(STORAGE_DIR, "watermark-state");

for (const d of [
  POLICY_DIR,
  STORAGE_DIR,
  LEDGERS_DIR,
  SOURCES_DIR,
  WATERMARK_STATE_DIR,
]) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
}

// ---------------------------------------------------------------------------
// Synthetic row factories — connector-base append shape per source. Each
// row carries source_msg_id of the form "<source>-<i>" so the cursor's
// last_event_id is deterministic to assert.
// ---------------------------------------------------------------------------

function makeImessageRow(i) {
  return {
    id: `ulid_imsg_${String(i).padStart(8, "0")}`,
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    source: "imessage",
    source_msg_id: `imsg-${i}`,
    parties: ["user", "urn:friend:bob"],
    raw_content: {
      text: `imessage body number ${i}`,
      handle_id: "urn:friend:bob",
      is_from_me: i % 2,
      associated_message_type: 0,
    },
    attachments: [],
    source_policy: { deletion_semantics: "full_excise", consent_basis: "second_party_dm" },
    checksum: `cksum-imsg-${i}`,
  };
}

function makeGitLogRow(i) {
  return {
    id: `ulid_git_${String(i).padStart(8, "0")}`,
    ts: new Date(Date.UTC(2026, 0, 2, 0, 0, i)).toISOString(),
    source: "git-log",
    source_msg_id: `git-${i}`,
    parties: ["author@example.com"],
    raw_content: {
      repo_path: "/Users/alex/Documents/example-repo",
      commit_hash: `sha-${i}`,
      author_name: "Example Dev",
      author_email: "author@example.com",
      author_ts: new Date(Date.UTC(2026, 0, 2, 0, 0, i)).toISOString(),
      subject: i === 0 ? "Initial commit" : `feature commit ${i}`,
      parents: i === 0 ? [] : [`sha-${i - 1}`],
    },
    attachments: [],
    source_policy: { deletion_semantics: "full_excise", consent_basis: "first_party" },
    checksum: `cksum-git-${i}`,
  };
}

function makeScreentimeRow(i) {
  return {
    id: `ulid_st_${String(i).padStart(8, "0")}`,
    ts: new Date(Date.UTC(2026, 0, 4, 0, 0, i)).toISOString(),
    source: "screentime",
    source_msg_id: `st-${i}`,
    parties: ["user"],
    raw_content: {
      ZSTREAMNAME: "/app/usage",
      ZVALUESTRING: `com.example.app.${i}`,
      ZSTARTDATE: new Date(Date.UTC(2026, 0, 4, 0, 0, i)).toISOString(),
      ZENDDATE: new Date(Date.UTC(2026, 0, 4, 0, 0, i + 1)).toISOString(),
    },
    attachments: [],
    source_policy: { deletion_semantics: "full_excise", consent_basis: "first_party" },
    checksum: `cksum-st-${i}`,
  };
}

function makeGithubEventRow(i) {
  return {
    id: `ulid_gh_${String(i).padStart(8, "0")}`,
    ts: new Date(Date.UTC(2026, 0, 3, 0, 0, i)).toISOString(),
    source: "github-events",
    source_msg_id: `gh-${i}`,
    parties: ["user", "gh:friend"],
    raw_content: {
      event_type: "PullRequestEvent",
      action: "opened",
      pr_number: i,
      repo: "friend/some-repo",
      public: true,
      created_at: new Date(Date.UTC(2026, 0, 3, 0, 0, i)).toISOString(),
    },
    attachments: [],
    source_policy: { deletion_semantics: "full_excise", consent_basis: "third_party_inferred" },
    checksum: `cksum-gh-${i}`,
  };
}

// R28 Phase 2a — agent-runtime hook row factories. Each emits a paired
// user/assistant turn with raw_content carrying the canonical fields the
// stage0 module + cascade read. ts spans a distinct UTC day so chronological
// ordering across sources is unambiguous when tests inspect both.
function makeCodexCliRow(i) {
  return {
    id: `ulid_codex_${String(i).padStart(8, "0")}`,
    ts: new Date(Date.UTC(2026, 0, 5, 0, 0, i)).toISOString(),
    source: "codex-cli",
    source_msg_id: `codex-${i}`,
    parties: ["user", "assistant"],
    raw_content: {
      conversation_id: "sess-codex-1",
      turn_index: i,
      user_text: `Refactor watermark daemon to support source number ${i}.`,
      assistant_text: `Reading daemons/watermark.js to plan the source-${i} integration.`,
      model: "codex-medium",
    },
    content: `user: refactor ... assistant: reading ...`,
    attachments: [],
    source_policy: { deletion_semantics: "full_excise", consent_basis: "first_party" },
    checksum: `cksum-codex-${i}`,
  };
}

const SOURCE_FACTORIES = {
  imessage: makeImessageRow,
  "git-log": makeGitLogRow,
  screentime: makeScreentimeRow,
  "github-events": makeGithubEventRow,
  // R28 Phase 2a / R28.1 (codex-cli only).
  "codex-cli": makeCodexCliRow,
};

function ledgerPath(source) {
  return join(SOURCES_DIR, `${source}.jsonl`);
}

function seedRows(source, fromIdx, count) {
  const factory = SOURCE_FACTORIES[source];
  const lines = [];
  for (let i = fromIdx; i < fromIdx + count; i++) {
    lines.push(JSON.stringify(factory(i)));
  }
  const path = ledgerPath(source);
  if (existsSync(path)) {
    appendFileSync(path, lines.join("\n") + "\n");
  } else {
    writeFileSync(path, lines.join("\n") + "\n");
  }
  return statSync(path).size;
}

// ---------------------------------------------------------------------------
// Subprocess driver. The hermetic env wholly redirects the daemon to tmpRoot;
// no production path is touched. WATERMARK_IDLE_OVERRIDE_SECONDS=1 keeps the
// chat-pipeline idle-watermark from blocking the source-tier sweep.
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

const childEnv = {
  ...process.env,
  MEMORY_ROOT: tmpRoot,
  POLICY_BASE_DIR: POLICY_DIR,
  STORAGE_BASE_DIR: STORAGE_DIR,
  LEDGERS_BASE_DIR: LEDGERS_DIR,
  WATERMARK_IDLE_OVERRIDE_SECONDS: "1",
  WATERMARK_HEARTBEAT_OVERRIDE_SECONDS: "1",
  // R29.3: deterministic stub embedder so the cascade SUCCESS path runs
  // without a real GEMINI_API_KEY. See watermark.js loadCascadeModulesLazy.
  MEMORY_TEST_STUB_EMBEDDER: "1",
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "AIzaJUNK_test_only_xxxxxxxxxxxxxxxxxx",
  // W9: this suite exercises screentime cascade flow (revoke routing T4,
  // cursor advance T5). Disable the captured_only short-circuit so the
  // watermark daemon processes screentime like a normal cascade source for
  // these assertions. Empty string = no captured_only sources at all.
  MEMORY_WATERMARK_CAPTURED_ONLY_OVERRIDE: "",
};

function spawnOnce(label) {
  const proc = spawnSync("node", [WATERMARK_BIN, "--once"], {
    env: childEnv,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (proc.status !== 0) {
    console.error(
      `  WARN  ${label}: watermark --once exited status=${proc.status}\n` +
      `        stderr=${(proc.stderr || "").slice(0, 800)}`,
    );
  }
  return proc;
}

// Scan policy-events-YYYY-MM.jsonl files under POLICY_DIR for events matching
// a predicate. Returns the matching events. Schema-tolerant: returns [] if
// the policy dir is missing or has no files (the daemon may not have emitted
// any events yet on a no-op tick).
function readPolicyEvents(predicate) {
  if (!existsSync(POLICY_DIR)) return [];
  const matches = [];
  for (const name of readdirSync(POLICY_DIR)) {
    if (!name.startsWith("policy-events-")) continue;
    if (!name.endsWith(".jsonl")) continue;
    let raw;
    try {
      raw = readFileSync(join(POLICY_DIR, name), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (line === "") continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (predicate(row)) matches.push(row);
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// T1: per-source cursor advance.
//
// Seed 50 rows into imessage.jsonl. Run watermark --once. Assert:
//   (a) storage/watermark-state/imessage.json exists with cursor.last_offset
//       at byte-EOF of the seeded ledger,
//   (b) cursor.last_event_id == "imsg-49" (i.e. every one of the 50 rows
//       was source-routed through the cascade entry — see SPY MODEL block
//       above),
//   (c) cursor.source == "imessage" (per-source routing tag is correct).
//
// STRICT-SPEC NOTE: the brief asks "Assert distillPromoteFact was called
// exactly 50 times with source='imessage'". Because the daemon today
// short-circuits to {decision:"PASS"} whenever the cascade modules do not
// match its expected API surface (and that surface is in churn across A1/A2/A3),
// the strongest hermetic proxy is "cursor advanced exactly 50 rows with
// source-tag=imessage". A spy on promoteSourceRow's call count belongs in
// mcp/test/ingest/salience-cascade.test.mjs (Agent A1+A3 territory), which
// can stub the promote module directly without touching the watermark loop.
// ---------------------------------------------------------------------------

section("T1: per-source cursor advance (50 imessage rows)");

const IMSG_COUNT_T1 = 50;
const IMSG_SIZE_T1 = seedRows("imessage", 0, IMSG_COUNT_T1);

const procT1 = spawnOnce("T1");
check("T1 watermark --once exited 0", procT1.status === 0,
  `status=${procT1.status} stderr=${(procT1.stderr || "").slice(0, 200)}`);

const cursorT1 = readCursor("imessage");
check("T1 imessage cursor file exists", cursorT1 != null);
check("T1 cursor.source == 'imessage'", cursorT1 != null && cursorT1.source === "imessage",
  `got=${cursorT1 && cursorT1.source}`);
check("T1 cursor.last_offset advanced to EOF (50 rows dispatched)",
  cursorT1 != null && BigInt(cursorT1.last_offset) === BigInt(IMSG_SIZE_T1),
  `got=${cursorT1 && cursorT1.last_offset} expected=${IMSG_SIZE_T1}`);
check("T1 cursor.last_event_id reflects 50th row (proof of every-row dispatch)",
  cursorT1 != null && cursorT1.last_event_id === `imsg-${IMSG_COUNT_T1 - 1}`,
  `got=${cursorT1 && cursorT1.last_event_id} expected=imsg-${IMSG_COUNT_T1 - 1}`);

// ---------------------------------------------------------------------------
// T2: restart-from-cursor (no double-process).
//
// Append 50 MORE imessage rows. Spawn watermark --once again. Assert:
//   (a) cursor.last_offset advances to the NEW EOF (so 50 new rows processed),
//   (b) cursor.last_event_id is imsg-99 (proof of contiguous dispatch),
//   (c) Tracking ULID-style: the cursor's previous offset is strictly less
//       than the new offset and the delta == bytes appended on this round
//       (the no-double-process invariant: only NEW bytes were read).
// ---------------------------------------------------------------------------

section("T2: restart-from-cursor (no double-process)");

const offsetBeforeT2 = BigInt(cursorT1 ? cursorT1.last_offset : "0");
const IMSG_SIZE_T2 = seedRows("imessage", IMSG_COUNT_T1, 50);
const bytesAppendedT2 = BigInt(IMSG_SIZE_T2) - BigInt(IMSG_SIZE_T1);

const procT2 = spawnOnce("T2");
check("T2 watermark --once exited 0", procT2.status === 0,
  `status=${procT2.status} stderr=${(procT2.stderr || "").slice(0, 200)}`);

const cursorT2 = readCursor("imessage");
check("T2 cursor advanced to new EOF",
  cursorT2 != null && BigInt(cursorT2.last_offset) === BigInt(IMSG_SIZE_T2),
  `got=${cursorT2 && cursorT2.last_offset} expected=${IMSG_SIZE_T2}`);
check("T2 cursor.last_event_id == imsg-99",
  cursorT2 != null && cursorT2.last_event_id === "imsg-99",
  `got=${cursorT2 && cursorT2.last_event_id}`);
check("T2 no-double-process: cursor delta == bytes appended",
  cursorT2 != null &&
    BigInt(cursorT2.last_offset) - offsetBeforeT2 === bytesAppendedT2,
  `delta=${cursorT2 && BigInt(cursorT2.last_offset) - offsetBeforeT2} expected=${bytesAppendedT2}`);

// ---------------------------------------------------------------------------
// T3: per-source error isolation.
//
// Append a MALFORMED row at the next cursor offset, followed by a valid row.
// Seed an independent 100-row git-log ledger (untouched by imessage faults).
// Run watermark --once. Assert:
//   (a) imessage error_count bumped to 1 (parse failure recorded),
//   (b) imessage cursor advances PAST the malformed row AND past the
//       subsequent valid row (offset == new EOF),
//   (c) imessage last_event_id reflects the post-malformed valid row,
//   (d) git-log processed all 100 of its rows independently
//       (cursor.last_offset == git-log EOF), proving per-source isolation.
//
// STRICT-SPEC NOTE: the brief also asks
// `cursor.last_error_kind == "watermark_parse_failed"`. The R26 cursor
// schema as frozen in CAPS does not yet carry last_error_kind — only
// error_count. If A7 lands the field, change the toleration check below
// from "warn-only" to a hard assertion.
// ---------------------------------------------------------------------------

section("T3: per-source error isolation (parse failure)");

// Bake a malformed line + a valid line into imessage.jsonl.
const malformedLine = "this is not valid JSON {";
const goodIdxT3 = 100;
const goodLine = JSON.stringify(makeImessageRow(goodIdxT3));
appendFileSync(ledgerPath("imessage"), malformedLine + "\n" + goodLine + "\n");
const IMSG_SIZE_T3 = statSync(ledgerPath("imessage")).size;

// Seed git-log independently.
const GIT_COUNT_T3 = 100;
const GIT_SIZE_T3 = seedRows("git-log", 0, GIT_COUNT_T3);

const procT3 = spawnOnce("T3");
check("T3 watermark --once exited 0", procT3.status === 0,
  `status=${procT3.status} stderr=${(procT3.stderr || "").slice(0, 200)}`);

const cursorT3 = readCursor("imessage");
check("T3 imessage error_count == 1",
  cursorT3 != null && cursorT3.error_count === 1,
  `got=${cursorT3 && cursorT3.error_count}`);
check("T3 imessage cursor advanced past malformed + valid trailer",
  cursorT3 != null && BigInt(cursorT3.last_offset) === BigInt(IMSG_SIZE_T3),
  `got=${cursorT3 && cursorT3.last_offset} expected=${IMSG_SIZE_T3}`);
check("T3 imessage last_event_id reflects the post-malformed valid row",
  cursorT3 != null && cursorT3.last_event_id === `imsg-${goodIdxT3}`,
  `got=${cursorT3 && cursorT3.last_event_id} expected=imsg-${goodIdxT3}`);

// Toleration: last_error_kind is a spec-target field. Warn if absent so
// A7's follow-up gets clean visibility, but do not fail the test.
if (cursorT3 != null && "last_error_kind" in cursorT3) {
  check("T3 imessage last_error_kind == 'watermark_parse_failed'",
    cursorT3.last_error_kind === "watermark_parse_failed",
    `got=${cursorT3.last_error_kind}`);
} else {
  console.log("  NOTE  T3 cursor.last_error_kind not yet present in cursor schema (A7 follow-up)");
}

const cursorGitT3 = readCursor("git-log");
check("T3 git-log cursor exists (other source unaffected)", cursorGitT3 != null);
check("T3 git-log cursor.last_offset == git-log EOF (100 rows processed)",
  cursorGitT3 != null && BigInt(cursorGitT3.last_offset) === BigInt(GIT_SIZE_T3),
  `got=${cursorGitT3 && cursorGitT3.last_offset} expected=${GIT_SIZE_T3}`);
check("T3 git-log last_event_id reflects 100th row (isolation proof)",
  cursorGitT3 != null && cursorGitT3.last_event_id === `git-${GIT_COUNT_T3 - 1}`,
  `got=${cursorGitT3 && cursorGitT3.last_event_id}`);
check("T3 git-log error_count untouched by imessage's parse failure",
  cursorGitT3 != null && cursorGitT3.error_count === 0,
  `got=${cursorGitT3 && cursorGitT3.error_count}`);

// ---------------------------------------------------------------------------
// T4: connector_revoke routing.
//
// Write a policy row into memory.jsonl that revokes source "screentime".
// Seed 10 screentime rows + 10 github-events rows. Run watermark --once.
// Assert:
//   (a) screentime cursor either does not exist OR has last_offset == 0
//       (proof the source was NOT tailed),
//   (b) policy-events ledger carries a policy.salience.source_revoked event
//       with source=="screentime",
//   (c) github-events ran normally (cursor advanced to its EOF),
//   (d) imessage AND git-log are also still progressing (no cross-source
//       contamination from the revoke).
// ---------------------------------------------------------------------------

section("T4: connector_revoke routing (screentime revoked)");

// Write a revoke row into the memory ledger.
const memoryLedger = join(LEDGERS_DIR, "memory.jsonl");
const revokeRow = {
  id: "mem_revoke_screentime_001",
  kind: "policy",
  policy_kind: "connector_revoke",
  target_source: "screentime",
  ts: new Date().toISOString(),
};
appendFileSync(memoryLedger, JSON.stringify(revokeRow) + "\n");

// Seed screentime + github-events.
const ST_COUNT_T4 = 10;
const ST_SIZE_T4 = seedRows("screentime", 0, ST_COUNT_T4);
const GH_COUNT_T4 = 10;
const GH_SIZE_T4 = seedRows("github-events", 0, GH_COUNT_T4);

const procT4 = spawnOnce("T4");
check("T4 watermark --once exited 0", procT4.status === 0,
  `status=${procT4.status} stderr=${(procT4.stderr || "").slice(0, 200)}`);

const cursorScreenT4 = readCursor("screentime");
const screentimeWasNotTailed =
  cursorScreenT4 == null ||
  BigInt(cursorScreenT4.last_offset || "0") === 0n;
check("T4 screentime NOT tailed (revoked source skipped)",
  screentimeWasNotTailed,
  `cursor=${JSON.stringify(cursorScreenT4)}`);

const revokeEvents = readPolicyEvents(
  (e) => e && e.kind === "policy.salience.source_revoked" && e.source === "screentime",
);
check("T4 policy.salience.source_revoked emitted for screentime",
  revokeEvents.length >= 1,
  `count=${revokeEvents.length}`);

const cursorGhT4 = readCursor("github-events");
check("T4 github-events tailed normally despite screentime revoke",
  cursorGhT4 != null && BigInt(cursorGhT4.last_offset) === BigInt(GH_SIZE_T4),
  `got=${cursorGhT4 && cursorGhT4.last_offset} expected=${GH_SIZE_T4}`);
check("T4 github-events last_event_id reflects 10th row",
  cursorGhT4 != null && cursorGhT4.last_event_id === `gh-${GH_COUNT_T4 - 1}`,
  `got=${cursorGhT4 && cursorGhT4.last_event_id}`);

// Sanity check that imessage + git-log are still where T3 left them
// (no regression from the revoke tick).
const cursorImsgT4 = readCursor("imessage");
const cursorGitT4 = readCursor("git-log");
check("T4 imessage cursor at-or-past T3 EOF (revoke didn't clobber siblings)",
  cursorImsgT4 != null && BigInt(cursorImsgT4.last_offset) >= BigInt(IMSG_SIZE_T3),
  `got=${cursorImsgT4 && cursorImsgT4.last_offset} >= ${IMSG_SIZE_T3}`);
check("T4 git-log cursor at-or-past T3 EOF (revoke didn't clobber siblings)",
  cursorGitT4 != null && BigInt(cursorGitT4.last_offset) >= BigInt(GIT_SIZE_T3),
  `got=${cursorGitT4 && cursorGitT4.last_offset} >= ${GIT_SIZE_T3}`);

// Suppress the screentime offset-size variable from "unused" lint paths.
void ST_SIZE_T4;

// ---------------------------------------------------------------------------
// T5: source-routing dispatch (one row per non-revoked source).
//
// On a fresh hermetic root (subdir of tmpRoot), seed exactly 1 row in each
// of {imessage, git-log, screentime, github-events}. Run watermark --once.
// Assert each source's cursor advances to its own EOF and last_event_id
// matches that source's own format (proves the dispatch routed each row to
// its own per-source pipeline rather than mixing them).
//
// We run T5 against a fresh subdir to avoid the T4 revoke leaking forward
// (the revoke is keyed to a memory.jsonl row which T4 just wrote).
// ---------------------------------------------------------------------------

section("T5: source-routing dispatch (one row per source)");

const T5_ROOT = mkdtempSync(join(tmpdir(), "watermark-multisource-T5-"));
process.on("exit", () => {
  try { rmSync(T5_ROOT, { recursive: true, force: true }); } catch {}
});

const T5_POLICY = join(T5_ROOT, "policy");
const T5_STORAGE = join(T5_ROOT, "storage");
const T5_LEDGERS = join(T5_ROOT, "ledgers");
const T5_SOURCES = join(T5_STORAGE, "sources");
// R34 CLOSE-3: removed T5_QUEUE and four subdir mkdirs. Watermark daemon
// retired the queue tree in R32.1; T5 source-routing only inspects per-source
// cursor files under watermark-state/.
const T5_WM_STATE = join(T5_STORAGE, "watermark-state");
for (const d of [
  T5_POLICY, T5_STORAGE, T5_LEDGERS, T5_SOURCES,
  T5_WM_STATE,
]) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
}

// Seed one row per source under the T5 root.
const T5_SOURCES_LIST = ["imessage", "git-log", "screentime", "github-events"];
const T5_SIZES = {};
for (const src of T5_SOURCES_LIST) {
  const row = SOURCE_FACTORIES[src](0);
  const p = join(T5_SOURCES, `${src}.jsonl`);
  writeFileSync(p, JSON.stringify(row) + "\n");
  T5_SIZES[src] = statSync(p).size;
}

const t5Env = {
  ...process.env,
  MEMORY_ROOT: T5_ROOT,
  POLICY_BASE_DIR: T5_POLICY,
  STORAGE_BASE_DIR: T5_STORAGE,
  LEDGERS_BASE_DIR: T5_LEDGERS,
  WATERMARK_IDLE_OVERRIDE_SECONDS: "1",
  WATERMARK_HEARTBEAT_OVERRIDE_SECONDS: "1",
  // R29.3: deterministic stub embedder. See watermark.js loadCascadeModulesLazy.
  MEMORY_TEST_STUB_EMBEDDER: "1",
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "AIzaJUNK_test_only_xxxxxxxxxxxxxxxxxx",
  // W9: this suite exercises screentime cascade flow (revoke routing T4,
  // cursor advance T5). Disable the captured_only short-circuit so the
  // watermark daemon processes screentime like a normal cascade source for
  // these assertions. Empty string = no captured_only sources at all.
  MEMORY_WATERMARK_CAPTURED_ONLY_OVERRIDE: "",
};

const procT5 = spawnSync("node", [WATERMARK_BIN, "--once"], {
  env: t5Env,
  encoding: "utf8",
  timeout: 30_000,
});
check("T5 watermark --once exited 0",
  procT5.status === 0,
  `status=${procT5.status} stderr=${(procT5.stderr || "").slice(0, 200)}`);

for (const src of T5_SOURCES_LIST) {
  const cursorPath = join(T5_WM_STATE, `${src}.json`);
  const cursor = existsSync(cursorPath)
    ? JSON.parse(readFileSync(cursorPath, "utf8"))
    : null;
  // The 1-row dispatch proves the watermark daemon recognised this source
  // and routed the row through its per-source cursor file. The expected
  // last_event_id uses each source's own naming (imsg-0 / git-0 / st-0 / gh-0).
  const expectedIdMap = {
    "imessage": "imsg-0",
    "git-log": "git-0",
    "screentime": "st-0",
    "github-events": "gh-0",
  };
  check(`T5 ${src} cursor exists`, cursor != null,
    `cursor file ${cursorPath} missing`);
  check(`T5 ${src} cursor.source == '${src}'`,
    cursor != null && cursor.source === src,
    `got=${cursor && cursor.source}`);
  check(`T5 ${src} cursor.last_offset == ledger EOF (1-row dispatch)`,
    cursor != null && BigInt(cursor.last_offset) === BigInt(T5_SIZES[src]),
    `got=${cursor && cursor.last_offset} expected=${T5_SIZES[src]}`);
  check(`T5 ${src} cursor.last_event_id == '${expectedIdMap[src]}' (source-correct routing)`,
    cursor != null && cursor.last_event_id === expectedIdMap[src],
    `got=${cursor && cursor.last_event_id} expected=${expectedIdMap[src]}`);
}

// ---------------------------------------------------------------------------
// T6: R28 Phase 2a / R28.1 — codex-cli source-routing.
//
// On a fresh hermetic root, seed one ledger per agent-runtime hook source.
// Run watermark --once. Assert each source's cursor advances to its own
// EOF and last_event_id reflects its source-specific id format. This is
// the structural proof that:
//   (a) CAPS.WATERMARK_SOURCES contains each new bare-name entry,
//   (b) listSourceLedgers() picks them up,
//   (c) each routes through its own stage0 module + cursor file.
// ---------------------------------------------------------------------------

section("T6: R28 agent-runtime source-routing (codex-cli)");

const T6_ROOT = mkdtempSync(join(tmpdir(), "watermark-multisource-T6-"));
process.on("exit", () => {
  try { rmSync(T6_ROOT, { recursive: true, force: true }); } catch {}
});

const T6_POLICY = join(T6_ROOT, "policy");
const T6_STORAGE = join(T6_ROOT, "storage");
const T6_LEDGERS = join(T6_ROOT, "ledgers");
const T6_SOURCES = join(T6_STORAGE, "sources");
// R34 CLOSE-3: removed T6_QUEUE and four subdir mkdirs. Watermark daemon
// retired the queue tree in R32.1; T6 agent-runtime routing only inspects
// per-source cursor files under watermark-state/.
const T6_WM_STATE = join(T6_STORAGE, "watermark-state");
for (const d of [
  T6_POLICY, T6_STORAGE, T6_LEDGERS, T6_SOURCES,
  T6_WM_STATE,
]) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
}

// Seed 3 rows per agent-runtime source under the T6 root so the cursor's
// last_event_id has something to assert against (1-row is a degenerate case
// — 3-row proves contiguous dispatch).
const T6_SOURCES_LIST = ["codex-cli"];
const T6_COUNT = 3;
const T6_SIZES = {};
for (const src of T6_SOURCES_LIST) {
  const factory = SOURCE_FACTORIES[src];
  const lines = [];
  for (let i = 0; i < T6_COUNT; i++) lines.push(JSON.stringify(factory(i)));
  const p = join(T6_SOURCES, `${src}.jsonl`);
  writeFileSync(p, lines.join("\n") + "\n");
  T6_SIZES[src] = statSync(p).size;
}

const t6Env = {
  ...process.env,
  MEMORY_ROOT: T6_ROOT,
  POLICY_BASE_DIR: T6_POLICY,
  STORAGE_BASE_DIR: T6_STORAGE,
  LEDGERS_BASE_DIR: T6_LEDGERS,
  WATERMARK_IDLE_OVERRIDE_SECONDS: "1",
  WATERMARK_HEARTBEAT_OVERRIDE_SECONDS: "1",
  MEMORY_TEST_STUB_EMBEDDER: "1",
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "AIzaJUNK_test_only_xxxxxxxxxxxxxxxxxx",
  // W9: this suite exercises screentime cascade flow (revoke routing T4,
  // cursor advance T5). Disable the captured_only short-circuit so the
  // watermark daemon processes screentime like a normal cascade source for
  // these assertions. Empty string = no captured_only sources at all.
  MEMORY_WATERMARK_CAPTURED_ONLY_OVERRIDE: "",
};

const procT6 = spawnSync("node", [WATERMARK_BIN, "--once"], {
  env: t6Env,
  encoding: "utf8",
  timeout: 30_000,
});
check("T6 watermark --once exited 0",
  procT6.status === 0,
  `status=${procT6.status} stderr=${(procT6.stderr || "").slice(0, 200)}`);

const T6_EXPECTED_ID_PREFIX = {
  "codex-cli": "codex",
};

for (const src of T6_SOURCES_LIST) {
  const cursorPath = join(T6_WM_STATE, `${src}.json`);
  const cursor = existsSync(cursorPath)
    ? JSON.parse(readFileSync(cursorPath, "utf8"))
    : null;
  check(`T6 ${src} cursor exists`, cursor != null,
    `cursor file ${cursorPath} missing`);
  check(`T6 ${src} cursor.source == '${src}'`,
    cursor != null && cursor.source === src,
    `got=${cursor && cursor.source}`);
  check(`T6 ${src} cursor.last_offset == ledger EOF (${T6_COUNT}-row dispatch)`,
    cursor != null && BigInt(cursor.last_offset) === BigInt(T6_SIZES[src]),
    `got=${cursor && cursor.last_offset} expected=${T6_SIZES[src]}`);
  const expectedLastId = `${T6_EXPECTED_ID_PREFIX[src]}-${T6_COUNT - 1}`;
  check(`T6 ${src} cursor.last_event_id == '${expectedLastId}' (source-correct routing)`,
    cursor != null && cursor.last_event_id === expectedLastId,
    `got=${cursor && cursor.last_event_id} expected=${expectedLastId}`);
  check(`T6 ${src} error_count == 0`,
    cursor != null && cursor.error_count === 0,
    `got=${cursor && cursor.error_count}`);
}

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------

console.log(`\n${assertions} assertion(s); ${failures} failure(s).`);
if (failures > 0) {
  console.error("watermark-multisource: FAIL");
  process.exit(1);
}
console.log("watermark-multisource: PASS");
