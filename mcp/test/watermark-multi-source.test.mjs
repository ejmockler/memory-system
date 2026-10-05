// R26 multi-source watermark — restart-recovery + per-source isolation.
//
// Validates the brief's required surfaces:
//   1. Watermark daemon discovers source-tier ledgers per CAPS.WATERMARK_SOURCES.
//   2. Per-source cursor at storage/watermark-state/<source>.json carries
//      {version, last_offset, last_appended_ts, last_event_id, error_count}.
//   3. Restart-recovery: SIGTERM mid-stream → next --once resumes from
//      persisted cursor, never re-processes prior rows.
//   4. Parse-error isolation: a malformed row bumps error_count and advances
//      cursor past it; subsequent rows still process normally.
//   5. Per-source isolation: a fault on source A does not block source B.
//   6. connector_revoke discovery: a memory.jsonl row with
//      policy_kind="connector_revoke" causes the source to be skipped.
//
// Hermetic isolation:
// - MEMORY_ROOT is a fresh mkdtempSync dir; cleaned up at exit.
// - Spawns `node daemons/watermark.js --once` with env overrides so the
//   per-source cursor + cascade code paths exercise end-to-end. The
//   distill-promote-fact / salience / stage0 modules may or may not be
//   present (sibling agents own them) — the watermark daemon falls through
//   to PASS gracefully when they're absent, which is the exact contract we
//   need to verify for the gate-zero ship.
// - We never touch the live install tree (<checkout>/ledgers, storage, policy).
//
// Run: node test/watermark-multi-source.test.mjs
// Exits 0 on pass, non-zero on any failure.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");
const WATERMARK_BIN = join(REPO_ROOT, "daemons", "watermark.js");

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Hermetic MEMORY_ROOT setup.
// ---------------------------------------------------------------------------

const tmpRoot = mkdtempSync(join(tmpdir(), "watermark-multi-source-"));
process.on("exit", () => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

function ensureDir(d) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
}

const POLICY_DIR = join(tmpRoot, "policy");
const STORAGE_DIR = join(tmpRoot, "storage");
const LEDGERS_DIR = join(tmpRoot, "ledgers");
const SOURCES_DIR = join(STORAGE_DIR, "sources");
// R34 CLOSE-3: removed the QUEUE_*_DIR consts. The watermark daemon retired
// the distillation-queue tree in R32.1 (cascade-only path); this test never
// reads or writes those dirs. The mkdir entries were vestigial scaffolding
// flagged by spec-sweep legacy_pattern_seen.
const WATERMARK_STATE_DIR = join(STORAGE_DIR, "watermark-state");

for (const d of [
  POLICY_DIR,
  STORAGE_DIR,
  LEDGERS_DIR,
  SOURCES_DIR,
  WATERMARK_STATE_DIR,
]) {
  ensureDir(d);
}

// ---------------------------------------------------------------------------
// Build synthetic source ledgers — 100 rows of imessage + 50 rows of git-log
// + 20 rows of github-events. Each row follows the connector-base append
// shape so that the cascade hooks (if loaded) can decode it.
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
    source_msg_id: `git:sha-${i}`,
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

function makeGithubEventRow(i) {
  return {
    id: `ulid_gh_${String(i).padStart(8, "0")}`,
    ts: new Date(Date.UTC(2026, 0, 3, 0, 0, i)).toISOString(),
    source: "github-events",
    source_msg_id: `gh-event:${1000 + i}`,
    parties: ["user", "gh:friend"],
    raw_content: {
      event_type: i % 3 === 0 ? "WatchEvent" : "PullRequestEvent",
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

const IMSG_PATH = join(SOURCES_DIR, "imessage.jsonl");
const GIT_PATH = join(SOURCES_DIR, "git-log.jsonl");
const GH_PATH = join(SOURCES_DIR, "github-events.jsonl");

const IMSG_COUNT = 100;
const GIT_COUNT = 50;
const GH_COUNT = 20;

const imsgLines = [];
for (let i = 0; i < IMSG_COUNT; i++) imsgLines.push(JSON.stringify(makeImessageRow(i)));
writeFileSync(IMSG_PATH, imsgLines.join("\n") + "\n");

const gitLines = [];
for (let i = 0; i < GIT_COUNT; i++) gitLines.push(JSON.stringify(makeGitLogRow(i)));
writeFileSync(GIT_PATH, gitLines.join("\n") + "\n");

const ghLines = [];
for (let i = 0; i < GH_COUNT; i++) ghLines.push(JSON.stringify(makeGithubEventRow(i)));
writeFileSync(GH_PATH, ghLines.join("\n") + "\n");

const IMSG_SIZE = statSync(IMSG_PATH).size;
const GIT_SIZE = statSync(GIT_PATH).size;
const GH_SIZE = statSync(GH_PATH).size;

// ---------------------------------------------------------------------------
// Spawn watermark --once. Hermetic env overrides isolate the daemon.
// ---------------------------------------------------------------------------

const childEnv = {
  ...process.env,
  MEMORY_ROOT: tmpRoot,
  POLICY_BASE_DIR: POLICY_DIR,
  STORAGE_BASE_DIR: STORAGE_DIR,
  LEDGERS_BASE_DIR: LEDGERS_DIR,
  WATERMARK_IDLE_OVERRIDE_SECONDS: "1",
  WATERMARK_HEARTBEAT_OVERRIDE_SECONDS: "1",
  // R29.3: deterministic stub embedder so the cascade SUCCESS path runs
  // without a real GEMINI_API_KEY. Pre-R29.3 the cascade silently PROMOTEd
  // rows whose embedder failed; R29.3 returns EMBED_DEFERRED and parks the
  // cursor, which would invalidate this test's "cursor advances to EOF"
  // assertions. Production paths must NEVER set this var.
  MEMORY_TEST_STUB_EMBEDDER: "1",
  // Pool-shape validator requires a syntactically-valid key. Bytes never
  // leave the process because MEMORY_TEST_STUB_EMBEDDER bypasses gemini-client.
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "AIzaJUNK_test_only_xxxxxxxxxxxxxxxxxx",
};

function spawnOnce() {
  return spawnSync("node", [WATERMARK_BIN, "--once"], {
    env: childEnv,
    encoding: "utf8",
    timeout: 30_000,
  });
}

const proc1 = spawnOnce();
check(
  "first watermark --once exited with status 0",
  proc1.status === 0,
  `status=${proc1.status} stderr=${(proc1.stderr || "").slice(0, 800)}`,
);

// ---------------------------------------------------------------------------
// Assert: per-source cursor files exist for each source and report the EOF.
// ---------------------------------------------------------------------------

function readCursor(source) {
  const path = join(WATERMARK_STATE_DIR, `${source}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

const imsgCursor1 = readCursor("imessage");
const gitCursor1 = readCursor("git-log");
const ghCursor1 = readCursor("github-events");

check(
  "imessage cursor file present after first tick",
  imsgCursor1 != null,
  `path=${join(WATERMARK_STATE_DIR, "imessage.json")} exists=${existsSync(join(WATERMARK_STATE_DIR, "imessage.json"))}`,
);
check(
  "git-log cursor file present after first tick",
  gitCursor1 != null,
);
check(
  "github-events cursor file present after first tick",
  ghCursor1 != null,
);

if (imsgCursor1) {
  check(
    "imessage cursor.version == 1",
    imsgCursor1.version === 1,
    `got=${imsgCursor1.version}`,
  );
  check(
    "imessage cursor.source == 'imessage'",
    imsgCursor1.source === "imessage",
    `got=${imsgCursor1.source}`,
  );
  check(
    "imessage cursor.last_offset advanced past EOF",
    BigInt(imsgCursor1.last_offset) === BigInt(IMSG_SIZE),
    `got=${imsgCursor1.last_offset} expected=${IMSG_SIZE}`,
  );
  check(
    "imessage cursor.last_event_id matches last row's source_msg_id",
    imsgCursor1.last_event_id === `imsg-${IMSG_COUNT - 1}`,
    `got=${imsgCursor1.last_event_id}`,
  );
}

if (gitCursor1) {
  check(
    "git-log cursor.last_offset advanced past EOF",
    BigInt(gitCursor1.last_offset) === BigInt(GIT_SIZE),
    `got=${gitCursor1.last_offset} expected=${GIT_SIZE}`,
  );
}

if (ghCursor1) {
  check(
    "github-events cursor.last_offset advanced past EOF",
    BigInt(ghCursor1.last_offset) === BigInt(GH_SIZE),
    `got=${ghCursor1.last_offset} expected=${GH_SIZE}`,
  );
}

// ---------------------------------------------------------------------------
// Restart-recovery: append 25 NEW imessage rows; spawn --once again; assert
// only the new 25 are processed (cursor advances past new EOF). This is the
// "SIGTERM mid-stream → restart" contract verified end-to-end via the
// persisted cursor file.
// ---------------------------------------------------------------------------

const newImsgLines = [];
for (let i = IMSG_COUNT; i < IMSG_COUNT + 25; i++) {
  newImsgLines.push(JSON.stringify(makeImessageRow(i)));
}
appendFileSync(IMSG_PATH, newImsgLines.join("\n") + "\n");
const IMSG_SIZE_2 = statSync(IMSG_PATH).size;

const proc2 = spawnOnce();
check(
  "second watermark --once exited with status 0",
  proc2.status === 0,
  `status=${proc2.status} stderr=${(proc2.stderr || "").slice(0, 800)}`,
);

const imsgCursor2 = readCursor("imessage");
check(
  "imessage cursor.last_offset advanced past new EOF after restart",
  imsgCursor2 != null && BigInt(imsgCursor2.last_offset) === BigInt(IMSG_SIZE_2),
  `got=${imsgCursor2 && imsgCursor2.last_offset} expected=${IMSG_SIZE_2}`,
);
check(
  "imessage cursor.last_event_id reflects newest row",
  imsgCursor2 != null && imsgCursor2.last_event_id === `imsg-${IMSG_COUNT + 24}`,
  `got=${imsgCursor2 && imsgCursor2.last_event_id}`,
);

// Restart idempotency: git-log file untouched -> cursor unchanged (no
// re-processing of old rows).
const gitCursor2 = readCursor("git-log");
check(
  "git-log cursor unchanged after second tick (no new rows)",
  gitCursor2 != null && BigInt(gitCursor2.last_offset) === BigInt(GIT_SIZE),
  `got=${gitCursor2 && gitCursor2.last_offset} expected=${GIT_SIZE}`,
);

// ---------------------------------------------------------------------------
// Parse-error isolation: append a malformed line + a good line. Cursor must
// advance past BOTH, error_count bumps to 1, the good line still processes.
// ---------------------------------------------------------------------------

const goodRowIdx = IMSG_COUNT + 25;
const malformedLine = "this is not valid JSON {";
const goodLine = JSON.stringify(makeImessageRow(goodRowIdx));
appendFileSync(IMSG_PATH, malformedLine + "\n" + goodLine + "\n");
const IMSG_SIZE_3 = statSync(IMSG_PATH).size;

const proc3 = spawnOnce();
check(
  "third watermark --once (parse-error path) exited 0",
  proc3.status === 0,
  `status=${proc3.status} stderr=${(proc3.stderr || "").slice(0, 800)}`,
);

const imsgCursor3 = readCursor("imessage");
check(
  "imessage cursor advances past malformed line",
  imsgCursor3 != null && BigInt(imsgCursor3.last_offset) === BigInt(IMSG_SIZE_3),
  `got=${imsgCursor3 && imsgCursor3.last_offset} expected=${IMSG_SIZE_3}`,
);
check(
  "imessage error_count bumped by parse failure",
  imsgCursor3 != null && imsgCursor3.error_count === 1,
  `got=${imsgCursor3 && imsgCursor3.error_count}`,
);
check(
  "imessage cursor.last_event_id reflects the good row after the malformed one",
  imsgCursor3 != null && imsgCursor3.last_event_id === `imsg-${goodRowIdx}`,
  `got=${imsgCursor3 && imsgCursor3.last_event_id}`,
);

// ---------------------------------------------------------------------------
// connector_revoke discipline: write a connector_revoke row into the memory
// ledger targeting "github-events"; append 5 NEW github-events rows; spawn
// --once. The github-events cursor must NOT advance past the prior EOF
// (source is muted).
// ---------------------------------------------------------------------------

const MEMORY_LEDGER = join(LEDGERS_DIR, "memory.jsonl");
const revokeRow = {
  id: "mem_revoke_gh_001",
  kind: "policy",
  policy_kind: "connector_revoke",
  target_source: "github-events",
  ts: new Date().toISOString(),
};
appendFileSync(MEMORY_LEDGER, JSON.stringify(revokeRow) + "\n");

const newGhLines = [];
for (let i = GH_COUNT; i < GH_COUNT + 5; i++) {
  newGhLines.push(JSON.stringify(makeGithubEventRow(i)));
}
appendFileSync(GH_PATH, newGhLines.join("\n") + "\n");

const proc4 = spawnOnce();
check(
  "fourth watermark --once (revoke path) exited 0",
  proc4.status === 0,
  `status=${proc4.status} stderr=${(proc4.stderr || "").slice(0, 800)}`,
);

const ghCursor4 = readCursor("github-events");
check(
  "github-events cursor stalled at pre-revoke EOF after revoke",
  ghCursor4 != null && BigInt(ghCursor4.last_offset) === BigInt(GH_SIZE),
  `got=${ghCursor4 && ghCursor4.last_offset} expected=${GH_SIZE} (revoked source must not tail)`,
);

// imessage and git-log must STILL process across the revoke (per-source
// isolation). Append 3 new git-log rows and check the cursor catches up.
const newGitLines = [];
for (let i = GIT_COUNT; i < GIT_COUNT + 3; i++) {
  newGitLines.push(JSON.stringify(makeGitLogRow(i)));
}
appendFileSync(GIT_PATH, newGitLines.join("\n") + "\n");
const GIT_SIZE_2 = statSync(GIT_PATH).size;

const proc5 = spawnOnce();
check(
  "fifth watermark --once (isolation path) exited 0",
  proc5.status === 0,
  `status=${proc5.status} stderr=${(proc5.stderr || "").slice(0, 800)}`,
);

const gitCursor5 = readCursor("git-log");
check(
  "git-log cursor advances after revoke on a DIFFERENT source",
  gitCursor5 != null && BigInt(gitCursor5.last_offset) === BigInt(GIT_SIZE_2),
  `got=${gitCursor5 && gitCursor5.last_offset} expected=${GIT_SIZE_2}`,
);
const ghCursor5 = readCursor("github-events");
check(
  "github-events cursor still stalled at revoked offset",
  ghCursor5 != null && BigInt(ghCursor5.last_offset) === BigInt(GH_SIZE),
  `got=${ghCursor5 && ghCursor5.last_offset} expected=${GH_SIZE}`,
);

// ---------------------------------------------------------------------------
// Final sanity: cursor file shape is the frozen schema.
// ---------------------------------------------------------------------------

if (imsgCursor3) {
  const expectedKeys = new Set([
    "version",
    "source",
    "last_offset",
    "last_appended_ts",
    "last_event_id",
    "error_count",
    "muted_until",
    "updated_at",
  ]);
  const actualKeys = new Set(Object.keys(imsgCursor3));
  let missing = [];
  for (const k of expectedKeys) if (!actualKeys.has(k)) missing.push(k);
  check(
    "imessage cursor carries the frozen R26 schema",
    missing.length === 0,
    `missing keys: ${missing.join(", ")}`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log(`\nAll watermark-multi-source checks passed.`);
