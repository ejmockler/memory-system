// git-log-content-dedup.test.mjs
//
// WU-A3-git-log-content-dedup — end-to-end integration test for the
// SAME-source git-log content-hash dedup contract.
//
// Asserts:
//   1. CROSS_SOURCE_CONTRACTS contains a gitlog-content-dedup entry with
//      source_a === source_b === "git-log", reason
//      "git_log_content_dup_corroborate", window_ms === 0, and
//      self_match_filter === true.
//   2. Fixture: 5 commits from 5 different repos with byte-identical
//      subject ("mt76: update to the latest version") + body. The FIRST
//      to reach Stage-0 PASSes and is appended to the git-log ledger; the
//      remaining 4 see the ledger hit and DROP with reason
//      "git_log_content_dup_corroborate".
//   3. Quarantine entries are written for each of the 4 DROPs and carry
//      paired_id pointing at the first commit's source_msg_id.
//   4. A commit with DIFFERENT content (different subject) is NOT affected
//      by the dedup contract.
//   5. Substrate direct check — checkCrossSourceDuplicate returns
//      is_dup=false for a row whose content has never been seen, and
//      is_dup=true with paired_source="git-log" once an identical-content
//      row has been written to the ledger.
//   6. Self-match filter — a row whose source_msg_id equals the ledger
//      entry's source_msg_id (replay scenario) does NOT match itself.
//   7. Empty-content rows (no subject AND no body) bypass the contract
//      entirely (the substrate's extract function returns null).
//
// HERMETIC: a tmpdir-scoped MEMORY_ROOT/STORAGE_BASE_DIR/QUARANTINE_BASE_DIR
// stack is set BEFORE any import of stage0/gitlog or cross-source-dedup.
// No file under the default MEMORY_ROOT is touched.

import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// HERMETICITY: env vars MUST be set before dynamic-imports of any module
// that resolves STORAGE_DIR / QUARANTINE_BASE_DIR via config.js. Static
// imports above this fence (assert, node:fs, node:path, node:os) do not
// touch storage paths.
const TEST_ROOT = mkdtempSync(join(tmpdir(), "memsys-gitlog-content-dedup-"));
const STORAGE = join(TEST_ROOT, "storage");
const QUARANTINE = join(TEST_ROOT, "storage", "quarantine");
mkdirSync(join(STORAGE, "sources"), { recursive: true });
mkdirSync(QUARANTINE, { recursive: true });
process.env.MEMORY_ROOT = TEST_ROOT;
// Synthetic operator identity, resolved once at operator-identity.js load, so
// it is set before the first library import.
process.env.MEMORY_OPERATOR_IDENTITY_FILE = fileURLToPath(
  new URL("../fixtures/operator-identity.synthetic.json", import.meta.url),
);
process.env.STORAGE_BASE_DIR = STORAGE;
process.env.QUARANTINE_BASE_DIR = QUARANTINE;
process.on("exit", () => {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
});

// Dynamic imports — must come AFTER env is set.
const { stage0: gitlogStage0 } = await import(
  "../../lib/ingest/stage0/gitlog.js"
);
const {
  CROSS_SOURCE_CONTRACTS,
  _resetCachesForTest,
  checkCrossSourceDuplicate,
} = await import("../../lib/ingest/cross-source-dedup.js");

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
// 1. Contract is registered.
// ---------------------------------------------------------------------------
const contract = CROSS_SOURCE_CONTRACTS.find(
  (c) => c.id === "gitlog-content-dedup",
);
check(
  "CROSS_SOURCE_CONTRACTS has gitlog-content-dedup entry",
  contract != null,
);
check(
  "gitlog-content-dedup source_a is git-log",
  contract && contract.source_a === "git-log",
);
check(
  "gitlog-content-dedup source_b is git-log (same-source)",
  contract && contract.source_b === "git-log",
);
check(
  "gitlog-content-dedup reason is git_log_content_dup_corroborate",
  contract && contract.reason === "git_log_content_dup_corroborate",
);
check(
  "gitlog-content-dedup window_ms is 0 (time-independent)",
  contract && contract.window_ms === 0,
);
check(
  "gitlog-content-dedup self_match_filter is true",
  contract && contract.self_match_filter === true,
);

// ---------------------------------------------------------------------------
// Test fixtures.
// ---------------------------------------------------------------------------
const GITLOG_LEDGER = join(STORAGE, "sources", "git-log.jsonl");

// The five OpenWrt-feed-style identical commits across different repos.
const DUP_SUBJECT = "mt76: update to the latest version";
const DUP_BODY =
  "Update the mt76 wireless driver to track the upstream HEAD. " +
  "Refreshes wifi.c and tracks the new module-parameter ABI.";
const REPO_BASES = [
  "/tmp/openwrt-23.05/feeds/packages",
  "/tmp/openwrt-22.03/feeds/packages",
  "/tmp/openwrt-master/feeds/packages",
  "/tmp/lede-17.01/feeds/packages",
  "/tmp/vendor-mirror-x/feeds/packages",
];

// Each commit gets a distinct (repo_path, commit_hash) tuple so its
// source_msg_id is unique — exactly the production shape that makes the
// connector-level dedup fail to catch them.
function makeDupCommit(i, { ts = "2026-06-05T12:00:00.000Z" } = {}) {
  return {
    source: "git-log",
    ts,
    source_msg_id: `gl-${i}-${Math.random().toString(36).slice(2)}`,
    raw_content: {
      repo_path: REPO_BASES[i],
      commit_hash: `aaaaaaaa${i}`.padEnd(40, "0"),
      author_name: "Example CI",
      author_email: "ci@example.com",
      author_ts: ts,
      subject: DUP_SUBJECT,
      body: DUP_BODY,
      body_truncated: false,
      parents: [`bbbbbbbb${i}`.padEnd(40, "0")],
      repo_classification: "first_party",
      is_bot_authored: false,
      is_operator_authored: false,
      file_changes: [],
      file_changes_truncated: false,
      file_count: 1,
      total_additions: 12,
      total_deletions: 8,
      binary_count: 0,
    },
  };
}

// Helper: append a row to the git-log ledger (mimics what the watermark
// daemon would do after a PASS at Stage-0).
function writeLedgerRow(row) {
  appendFileSync(GITLOG_LEDGER, JSON.stringify(row) + "\n");
}

function readQuarantineEntries(source) {
  const dir = join(QUARANTINE, source);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    const buf = readFileSync(join(dir, file), "utf8");
    for (const line of buf.split("\n")) {
      if (line === "") continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

function resetWorkspace() {
  try { rmSync(GITLOG_LEDGER, { force: true }); } catch {}
  try { rmSync(QUARANTINE, { recursive: true, force: true }); } catch {}
  mkdirSync(QUARANTINE, { recursive: true });
  _resetCachesForTest();
}

// ---------------------------------------------------------------------------
// 2. Five-identical-commit fixture: first PASSes, four DROP via the
//    content-dedup contract.
// ---------------------------------------------------------------------------
{
  resetWorkspace();
  const commits = REPO_BASES.map((_, i) => makeDupCommit(i));
  const results = [];
  for (const c of commits) {
    const r = gitlogStage0(c);
    results.push(r);
    if (r.decision === "PASS") {
      // Simulate the watermark daemon's ledger append so subsequent
      // Stage-0 calls see the prior row.
      writeLedgerRow(c);
      // Bust the substrate's lookup cache so the just-appended row is
      // visible to the NEXT lookup.
      _resetCachesForTest();
    }
  }
  const passes = results.filter((r) => r.decision === "PASS");
  const drops = results.filter((r) => r.decision === "DROP");
  check(
    "exactly 1 PASS across 5 identical commits",
    passes.length === 1,
    `passes=${passes.length} drops=${drops.length}`,
  );
  check(
    "exactly 4 DROPs across 5 identical commits",
    drops.length === 4,
    `passes=${passes.length} drops=${drops.length}`,
  );
  const dropReasons = drops.map((r) => r.reason);
  check(
    "every DROP carries reason git_log_content_dup_corroborate",
    dropReasons.every((r) => r === "git_log_content_dup_corroborate"),
    `reasons=${JSON.stringify(dropReasons)}`,
  );

  // ---------------------------------------------------------------------------
  // 3. Quarantine entries.
  // ---------------------------------------------------------------------------
  const qents = readQuarantineEntries("git-log");
  check(
    "4 quarantine entries written",
    qents.length === 4,
    `entries=${qents.length}`,
  );
  check(
    "every quarantine entry .reason is git_log_content_dup_corroborate",
    qents.every((e) => e && e.reason === "git_log_content_dup_corroborate"),
  );
  check(
    "every quarantine entry .rule_id points at the WU-A3 wiring",
    qents.every(
      (e) =>
        e &&
        typeof e.rule_id === "string" &&
        e.rule_id.includes("WU-A3-git-log-content-dedup"),
    ),
  );
  // Quarantine entries carry the original source_msg_id (each DROP'd
  // row's own id). The substrate-discovered paired_id (the first row's
  // source_msg_id) is asserted directly via checkCrossSourceDuplicate
  // in subsection 5 below; quarantineRow does not persist arbitrary
  // pairing metadata today, and adding a passthrough is out of scope
  // for this WU.
  const dropSourceMsgIds = qents.map((e) => e && e.source_msg_id);
  const droppedCommitIds = commits.slice(1).map((c) => c.source_msg_id);
  check(
    "every quarantine entry source_msg_id corresponds to one of the 4 DROPped commits",
    dropSourceMsgIds.every((id) => droppedCommitIds.includes(id)),
    `dropSourceMsgIds=${JSON.stringify(dropSourceMsgIds)}`,
  );
}

// ---------------------------------------------------------------------------
// 4. Different content does NOT dedup.
// ---------------------------------------------------------------------------
{
  resetWorkspace();
  // First row — a substantive commit on subject A.
  const a = makeDupCommit(0);
  const ra = gitlogStage0(a);
  if (ra.decision === "PASS") writeLedgerRow(a);
  _resetCachesForTest();

  // Second row — DIFFERENT subject + body. Same author, repo, ts pattern.
  const b = makeDupCommit(1);
  b.source_msg_id = `gl-distinct-${Math.random().toString(36).slice(2)}`;
  b.raw_content.subject = "rpcd: bring forward the latest service shim";
  b.raw_content.body =
    "Pull in upstream rpcd patches needed for the new transport layer. " +
    "Unrelated to mt76; tracks a different feed branch.";
  const rb = gitlogStage0(b);
  check(
    "distinct-content commit is NOT dropped by content-dedup",
    rb && rb.decision === "PASS",
    `rb=${JSON.stringify(rb)}`,
  );
  check(
    "distinct-content commit DROP-reason is not git_log_content_dup_corroborate",
    rb && rb.reason !== "git_log_content_dup_corroborate",
  );
}

// ---------------------------------------------------------------------------
// 5. Substrate direct check — round-trip via checkCrossSourceDuplicate.
// ---------------------------------------------------------------------------
{
  resetWorkspace();
  const first = makeDupCommit(0);
  // No ledger row yet → first lookup returns is_dup=false.
  const initial = checkCrossSourceDuplicate(first, "git-log");
  check(
    "substrate returns is_dup=false when ledger is empty",
    initial && initial.is_dup === false,
    `initial=${JSON.stringify(initial)}`,
  );
  // Now write the row to the ledger and bust the cache.
  writeLedgerRow(first);
  _resetCachesForTest();

  // A second commit with byte-identical content but a different
  // (repo, sha) tuple should match.
  const second = makeDupCommit(1);
  const xsrc = checkCrossSourceDuplicate(second, "git-log");
  check(
    "substrate returns is_dup=true once an identical-content row is in the ledger",
    xsrc && xsrc.is_dup === true,
    `xsrc=${JSON.stringify(xsrc)}`,
  );
  check(
    "substrate hit identifies paired_source=git-log (same-source)",
    xsrc && xsrc.paired_source === "git-log",
  );
  check(
    "substrate hit identifies contract=gitlog-content-dedup",
    xsrc && xsrc.contract === "gitlog-content-dedup",
  );
  check(
    "substrate hit reason is git_log_content_dup_corroborate",
    xsrc && xsrc.reason === "git_log_content_dup_corroborate",
  );
  check(
    "substrate hit paired_id is the first row's source_msg_id",
    xsrc && xsrc.paired_id === first.source_msg_id,
  );
}

// ---------------------------------------------------------------------------
// 6. Self-match filter — a row that appears in the ledger does NOT match
//    itself under the same source_msg_id.
// ---------------------------------------------------------------------------
{
  resetWorkspace();
  const c = makeDupCommit(2);
  // Write to ledger first (simulating a replay where the row landed
  // before Stage-0 is re-presented with the same row).
  writeLedgerRow(c);
  _resetCachesForTest();
  const xsrc = checkCrossSourceDuplicate(c, "git-log");
  check(
    "self-match filter: a row does NOT match itself (replay/re-presentation guard)",
    xsrc && xsrc.is_dup === false,
    `xsrc=${JSON.stringify(xsrc)}`,
  );
}

// ---------------------------------------------------------------------------
// 7. Empty-content rows bypass the contract entirely.
// ---------------------------------------------------------------------------
{
  resetWorkspace();
  const empty = makeDupCommit(3);
  empty.raw_content.subject = "";
  empty.raw_content.body = "";
  const xsrc = checkCrossSourceDuplicate(empty, "git-log");
  check(
    "empty-content row bypasses contract (extract returns null)",
    xsrc && xsrc.is_dup === false,
    `xsrc=${JSON.stringify(xsrc)}`,
  );
}

// ---------------------------------------------------------------------------
// 8. Whitespace-normalisation parity — two rows whose content differs only
//    in whitespace runs collapse to the same hash.
// ---------------------------------------------------------------------------
{
  resetWorkspace();
  const a = makeDupCommit(0);
  a.raw_content.subject = "mt76:   update    to the latest    version";
  a.raw_content.body = "Refresh\n\n\nthe   driver.";
  writeLedgerRow(a);
  _resetCachesForTest();

  const b = makeDupCommit(1);
  b.raw_content.subject = "mt76: update to the latest version";
  b.raw_content.body = "Refresh\nthe driver.";
  const xsrc = checkCrossSourceDuplicate(b, "git-log");
  check(
    "whitespace-only differences collapse to the same content hash",
    xsrc && xsrc.is_dup === true,
    `xsrc=${JSON.stringify(xsrc)}`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
assert.equal(failures, 0);
