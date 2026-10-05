// git-log-local-connector.test.mjs — Phase 2b dev-context connector tests.
//
// Exercises lib/connectors/git-log-local.js:
//   T1 — synthetic repo with 3 commits → 3 ledger rows; consent_basis
//        "first_party" for operator-authored commits.
//   T2 — synthetic repo with a co-authored commit (different author_email) →
//        third_party_inferred per round-20 C1 authorship-trumps-audience.
//   T3 — cursor restart: runOnce twice; second call appends 0 commits (per-
//        repo cursor + base-class source_msg_id dedup both confirmed).
//   T4 — missing .git directory: graceful skip; errors=0, status="ok"
//        (empty repo discovery is not an error).
//   T5 — F-GIT_LOG-DEDUP-STREAM: streaming dedup-set build over a synthetic
//        multi-row ledger with a tiny injected chunk size (7 bytes) so every
//        line straddles chunk boundaries, incl. multi-byte UTF-8 + a
//        malformed row + a missing-newline final row.
//   T6 — F-GIT_LOG-GITDIR-VALIDATE: broken checkouts (empty .git carcass,
//        dangling submodule pointer file) are SKIPPED without inflating
//        error_count, once-per-classification; valid sibling repo still
//        emits.
//   T7 — F-GIT_LOG-DEDUP-STREAM failure path: stream read error → loud
//        fallback (stream_error stat + tagError), not silent.
//   T12.l/m/n — D5 gitlog-frontier-hardening: the first-run bound is tested
//        on the RAW record count (a parse-dropped record still defers);
//        ENOBUFS on the deferred walk is loud (stderr + errors) and freezes
//        the surface at the PRE-WALK frontier exactly once, never `[]`; the
//        dedup tail-window fallback re-appends the deferred walk at most once.
//
// HERMETICITY (C-NEW-2): all env vars set BEFORE the dynamic imports;
// synthetic git repos built in mkdtempSync. The live install's
// ledgers/memory.jsonl is unchanged (we capture mtime+size pre/post and fail
// if it drifts).
//
// Run: node test/git-log-local-connector.test.mjs

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import { spawnSync } from "node:child_process";

import { skipIfDaemonActive } from "./_hermetic-daemon-skip.mjs";
skipIfDaemonActive("git-log-local-connector");

// ---------------------------------------------------------------------------
// Hermetic root — env-before-dynamic-import discipline.
// ---------------------------------------------------------------------------
const TEST_ROOT = mkdtempSync(join(tmpdir(), "git-log-connector-test-"));
mkdirSync(join(TEST_ROOT, "policy"), { recursive: true });
mkdirSync(join(TEST_ROOT, "ledgers"), { recursive: true });
mkdirSync(join(TEST_ROOT, "storage", "sources"), { recursive: true });
mkdirSync(join(TEST_ROOT, "connectors"), { recursive: true });
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
process.env.CONNECTORS_BASE_DIR = join(TEST_ROOT, "connectors");
// Pin operator identity for the classifier.
process.env.GIT_LOG_OPERATOR_EMAILS = "operator@example.com";
process.on("exit", () => {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
});

// Production-safety pre-snapshot — fail if real memory.jsonl drifts.
const PROD_LEDGER = join(homedir(), "memory-system", "ledgers", "memory.jsonl");
let prodBefore = null;
try { const st = statSync(PROD_LEDGER); prodBefore = { mtimeMs: st.mtimeMs, size: st.size }; } catch {}

// ---------------------------------------------------------------------------
// Dynamic imports — bind to TEST_ROOT.
// ---------------------------------------------------------------------------
const { GitLogConnector } = await import("../lib/connectors/git-log-local.js");
// D2 (T14): the Stage-0 telemetry counters. Imported AFTER the env setup so
// telemetry.js resolves its sink via lib/config.js STORAGE_DIR under
// TEST_ROOT — counters never reach the real storage/telemetry sink.
const { snapshotCounters, resetForTests } = await import("../lib/ingest/stage0/telemetry.js");
const { STORAGE_DIR } = await import("../lib/config.js");

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// Helper: build a synthetic git repo at `repoDir` with N commits using the
// real `git` binary. Each commit is authored by `defaultAuthor` unless an
// override is passed per commit. Returns the absolute repo path.
function buildSyntheticRepo(repoDir, commits, defaultAuthor) {
  mkdirSync(repoDir, { recursive: true });
  function git(args, env) {
    const res = spawnSync("git", ["-C", repoDir, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    if (res.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
    }
    return res.stdout;
  }
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", defaultAuthor.name]);
  git(["config", "user.email", defaultAuthor.email]);
  // Pin a commit author date so the test is deterministic.
  const baseEpoch = 1717200000; // 2024-06-01
  // F-NEW-W5-VERIFY-GIT-LOG-LOCAL-T3-LEDGER-DRIFT: Stage-0 rule 1 (W2
  // closure) DROPs commits whose parents.length === 0 OR whose subject
  // matches /^["' ]*initial commit\b/i, AND the connector itself filters
  // those before append. Without a root sentinel commit the FIRST
  // user-supplied commit would be classified as the repo's initial commit
  // and silently dropped, leaving only N-1 rows in the ledger. Plant a
  // throwaway "Initial commit" with a distinct file so every USER-SUPPLIED
  // commit has at least one parent and survives the rule-1 drop. The
  // sentinel itself is correctly quarantined and does not count toward
  // the user-supplied commit roster.
  writeFileSync(join(repoDir, ".git-fixture-seed"), "seed\n");
  git(["add", ".git-fixture-seed"]);
  git(["commit", "-q", "-m", "Initial commit"], {
    GIT_AUTHOR_NAME: defaultAuthor.name,
    GIT_AUTHOR_EMAIL: defaultAuthor.email,
    GIT_AUTHOR_DATE: `${baseEpoch - 60} +0000`,
    GIT_COMMITTER_NAME: defaultAuthor.name,
    GIT_COMMITTER_EMAIL: defaultAuthor.email,
    GIT_COMMITTER_DATE: `${baseEpoch - 60} +0000`,
  });
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    const filePath = join(repoDir, c.filename || `f${i}.txt`);
    writeFileSync(filePath, c.content || `content ${i}\n`);
    git(["add", c.filename || `f${i}.txt`]);
    const authorName = c.author?.name || defaultAuthor.name;
    const authorEmail = c.author?.email || defaultAuthor.email;
    const epoch = baseEpoch + i * 60;
    git(["commit", "-q", "-m", c.subject], {
      GIT_AUTHOR_NAME: authorName,
      GIT_AUTHOR_EMAIL: authorEmail,
      GIT_AUTHOR_DATE: `${epoch} +0000`,
      GIT_COMMITTER_NAME: defaultAuthor.name,
      GIT_COMMITTER_EMAIL: defaultAuthor.email,
      GIT_COMMITTER_DATE: `${epoch} +0000`,
    });
  }
  return repoDir;
}

// Helper: read the source ledger as parsed rows.
function readLedger(source) {
  const path = join(STORAGE_DIR, "sources", `${source}.jsonl`);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8").trim();
  if (raw === "") return [];
  return raw.split("\n").map((l) => JSON.parse(l));
}

// Helper: clear ledger between tests so row counts are crisp.
function clearLedger(source) {
  const path = join(STORAGE_DIR, "sources", `${source}.jsonl`);
  try { rmSync(path); } catch {}
}

// ===========================================================================
// T1 — synthetic repo with 3 commits → 3 ledger rows, first_party
// ===========================================================================
console.log("\n--- T1: 3 operator-authored commits → 3 first_party rows ---");
{
  const repoDir = join(TEST_ROOT, "repo-t1");
  buildSyntheticRepo(repoDir, [
    { subject: "first commit", content: "a\n" },
    { subject: "second commit", content: "b\n" },
    { subject: "third commit", content: "c\n" },
  ], { name: "Operator", email: "operator@example.com" });

  const c = new GitLogConnector({ repoRoots: [repoDir], walkDepth: 0 });
  const res = await c.pollOnce();

  check("T1.a appended=3", res.appended === 3, JSON.stringify(res));
  check("T1.b errors=0", res.errors === 0);
  check("T1.c repos=1", res.repos === 1);

  const rows = readLedger("git-log");
  check("T1.d 3 rows on disk", rows.length === 3, `got ${rows.length}`);
  check("T1.e all rows source=git-log", rows.every((r) => r.source === "git-log"));
  check("T1.f all rows first_party", rows.every((r) => r.source_policy?.consent_basis === "first_party"));
  check("T1.g deletion_semantics=full_excise", rows.every((r) => r.source_policy?.deletion_semantics === "full_excise"));
  check("T1.h source_msg_id starts with git:", rows.every((r) => typeof r.source_msg_id === "string" && r.source_msg_id.startsWith("git:")));
  check("T1.i parties = [author_email]", rows.every((r) => Array.isArray(r.parties) && r.parties.length === 1 && r.parties[0] === "operator@example.com"));
  // e12: repo_path is now the repo's CANONICAL IDENTITY (dirname of its
  // git-common-dir), which git reports symlink-resolved. On macOS the test
  // tmpdir lives under /var -> /private/var, so the expected value is the
  // REALPATH of the repo, not the string we happened to build. A repo path
  // with no symlink in it (e.g. /Users/alex/Documents/example-repo) is its
  // own realpath, so this is a no-op there and such a repo keeps its hash,
  // which is why the fix needs no ledger migration. observed_repo_path keeps
  // the unresolved surface we actually walked.
  check("T1.j raw_content.repo_path stamped (canonical identity)",
    rows.every((r) => r.raw_content?.repo_path === realpathSync(repoDir)),
    JSON.stringify(rows.map((r) => r.raw_content?.repo_path)));
  check("T1.j2 raw_content.observed_repo_path is the discovered surface",
    rows.every((r) => r.raw_content?.observed_repo_path === repoDir),
    JSON.stringify(rows.map((r) => r.raw_content?.observed_repo_path)));
  check("T1.k commit_hash echoed in raw_content", rows.every((r) => typeof r.raw_content?.commit_hash === "string" && r.raw_content.commit_hash.length === 40));
  check("T1.l subject preserved", rows.map((r) => r.raw_content?.subject).sort().join(",") === "first commit,second commit,third commit");
  check("T1.m checksum stamped", rows.every((r) => /^[0-9a-f]{32}$/.test(r.checksum || "")));
  check("T1.n id starts with ulid_", rows.every((r) => typeof r.id === "string" && r.id.startsWith("ulid_")));

  clearLedger("git-log");
}

// ===========================================================================
// T2 — co-authored commit (different author_email) → third_party_inferred
// ===========================================================================
console.log("\n--- T2: co-authored commit → third_party_inferred ---");
{
  const repoDir = join(TEST_ROOT, "repo-t2");
  buildSyntheticRepo(repoDir, [
    { subject: "operator commit", content: "x\n" },
    {
      subject: "coauth commit",
      content: "y\n",
      author: { name: "Contributor", email: "contributor@example.com" },
    },
    { subject: "another operator commit", content: "z\n" },
  ], { name: "Operator", email: "operator@example.com" });

  // Reset the connectors/ dir so this test has a clean cursor.
  rmSync(join(TEST_ROOT, "connectors"), { recursive: true, force: true });
  mkdirSync(join(TEST_ROOT, "connectors"), { recursive: true });

  const c = new GitLogConnector({ repoRoots: [repoDir], walkDepth: 0 });
  const res = await c.pollOnce();
  check("T2.a appended=3", res.appended === 3, JSON.stringify(res));

  const rows = readLedger("git-log");
  check("T2.b 3 rows on disk", rows.length === 3);

  const operatorRows = rows.filter((r) => r.source_policy?.consent_basis === "first_party");
  const coauthRows = rows.filter((r) => r.source_policy?.consent_basis === "third_party_inferred");
  check("T2.c 2 first_party rows (operator authored)", operatorRows.length === 2, `got ${operatorRows.length}`);
  check("T2.d 1 third_party_inferred row (contributor authored)", coauthRows.length === 1, `got ${coauthRows.length}`);
  check("T2.e coauth row author_email is contributor", coauthRows[0]?.raw_content?.author_email === "contributor@example.com");
  check("T2.f coauth row parties[0] is contributor", coauthRows[0]?.parties?.[0] === "contributor@example.com");
  check("T2.g operator row author_email is operator", operatorRows[0]?.raw_content?.author_email === "operator@example.com");

  clearLedger("git-log");
}

// ===========================================================================
// T3 — cursor restart: second pollOnce appends 0 commits
// ===========================================================================
console.log("\n--- T3: cursor restart, second pollOnce appends 0 ---");
{
  const repoDir = join(TEST_ROOT, "repo-t3");
  buildSyntheticRepo(repoDir, [
    { subject: "c1", content: "1\n" },
    { subject: "c2", content: "2\n" },
    { subject: "c3", content: "3\n" },
  ], { name: "Operator", email: "operator@example.com" });

  // Clean cursor + ledger.
  rmSync(join(TEST_ROOT, "connectors"), { recursive: true, force: true });
  mkdirSync(join(TEST_ROOT, "connectors"), { recursive: true });

  const c = new GitLogConnector({ repoRoots: [repoDir], walkDepth: 0 });

  const r1 = await c.pollOnce();
  check("T3.a first poll appended=3", r1.appended === 3, JSON.stringify(r1));
  const ledger1 = readLedger("git-log");
  check("T3.b ledger has 3 rows after first poll", ledger1.length === 3);

  // Second poll: cursor at last seen sha; no new commits since then.
  const r2 = await c.pollOnce();
  check("T3.c second poll appended=0 (no new commits)", r2.appended === 0, JSON.stringify(r2));
  check("T3.d second poll errors=0", r2.errors === 0);
  const ledger2 = readLedger("git-log");
  check("T3.e ledger still has 3 rows after second poll", ledger2.length === 3);

  // Fresh connector instance (simulates daemon restart) — should still
  // dedupe via cursor + the base-class source_msg_id tail-read.
  const c2 = new GitLogConnector({ repoRoots: [repoDir], walkDepth: 0 });
  const r3 = await c2.pollOnce();
  check("T3.f post-restart poll appended=0", r3.appended === 0, JSON.stringify(r3));
  const ledger3 = readLedger("git-log");
  check("T3.g ledger still 3 rows after restart", ledger3.length === 3);

  clearLedger("git-log");
}

// ===========================================================================
// T4 — missing .git directory: graceful skip
// ===========================================================================
console.log("\n--- T4: no-git-dir roots → graceful skip, errors=0 ---");
{
  // Build a root that contains no .git directories anywhere.
  const emptyRoot = join(TEST_ROOT, "no-repos");
  mkdirSync(join(emptyRoot, "regular-dir", "nested"), { recursive: true });
  writeFileSync(join(emptyRoot, "regular-dir", "file.txt"), "not a repo");

  // Also include a non-existent root to confirm graceful absence handling.
  const nonExistent = join(TEST_ROOT, "does-not-exist");

  rmSync(join(TEST_ROOT, "connectors"), { recursive: true, force: true });
  mkdirSync(join(TEST_ROOT, "connectors"), { recursive: true });

  const c = new GitLogConnector({ repoRoots: [emptyRoot, nonExistent], walkDepth: 3 });
  const res = await c.pollOnce();

  check("T4.a appended=0 with no repos", res.appended === 0, JSON.stringify(res));
  check("T4.b errors=0 (empty result is not an error)", res.errors === 0);
  check("T4.c repos=0 discovered", res.repos === 0);

  const ledger = readLedger("git-log");
  check("T4.d ledger empty", ledger.length === 0);

  // Health surfaces ok.
  const h = c.reportHealth();
  check("T4.e reportHealth status=ok", h.status === "ok", `status=${h.status}`);
  check("T4.f error_rate=0", h.error_rate === 0);

  // The discovered-repos count must respect the walkDepth bound. With
  // walkDepth=0 and a root that is not itself a repo, no repos are found.
  rmSync(join(TEST_ROOT, "connectors"), { recursive: true, force: true });
  mkdirSync(join(TEST_ROOT, "connectors"), { recursive: true });
  const c2 = new GitLogConnector({ repoRoots: [emptyRoot], walkDepth: 0 });
  const res2 = await c2.pollOnce();
  check("T4.g walkDepth=0 on non-repo root yields repos=0", res2.repos === 0);

  clearLedger("git-log");
}

// ===========================================================================
// T5 — F-GIT_LOG-DEDUP-STREAM: streaming dedup-set build (chunk-boundary
// regression). The pre-fix _buildDedupSet did a whole-file readFileSync that
// threw ERR_STRING_TOO_LONG once the ledger passed Node's ~512 MB string cap
// and silently fell back to 256-line tail dedup (≈30k duplicate rows
// re-appended per poll). We can't build a 1.4 GB fixture cheaply, so instead
// we inject a 7-byte stream chunk so EVERY line straddles multiple chunks —
// exercising exactly the carry/reassembly logic the streaming path relies on.
// ===========================================================================
console.log("\n--- T5: streaming dedup-set build over synthetic ledger ---");
{
  clearLedger("git-log");
  const ledgerPath = join(STORAGE_DIR, "sources", "git-log.jsonl");
  const N = 400;
  const lines = [];
  for (let i = 0; i < N; i++) {
    // Multi-byte UTF-8 in some subjects so a chunk boundary lands inside a
    // multi-byte sequence (7-byte chunks guarantee it) — the Buffer-based
    // carry must reassemble these losslessly.
    const subject = i % 7 === 0 ? `naïve — commit 你好 №${i}` : `commit ${i}`;
    lines.push(JSON.stringify({ source_msg_id: `git:aaaabbbbcccc:sha${i}`, raw_content: { subject } }));
  }
  // Malformed row + row missing source_msg_id — both must count as skipped,
  // not abort the scan.
  lines.splice(200, 0, "{{{not json");
  lines.splice(300, 0, JSON.stringify({ raw_content: { subject: "no id" } }));
  // NO trailing newline on the final row — exercises the carry-flush path
  // (a partial append cut mid-write must still register for dedup).
  writeFileSync(ledgerPath, lines.join("\n"));

  const c = new GitLogConnector({ repoRoots: [join(TEST_ROOT, "no-repos")], walkDepth: 0, dedupStreamChunkBytes: 7 });
  check("T5.a first row is duplicate", c._isDuplicate(`git:aaaabbbbcccc:sha0`) === true);
  check("T5.b last (newline-less) row is duplicate", c._isDuplicate(`git:aaaabbbbcccc:sha${N - 1}`) === true);
  check("T5.c multi-byte-subject row is duplicate", c._isDuplicate(`git:aaaabbbbcccc:sha7`) === true);

  const stats = c.getDedupStats();
  check("T5.d built=true", stats.built === true);
  check("T5.e fallback_mode=false (streaming scan succeeded)", stats.fallback_mode === false);
  check("T5.f stream_error=null", stats.stream_error === null, `got ${stats.stream_error}`);
  check("T5.g unique_set_size=400", stats.unique_set_size === N, `got ${stats.unique_set_size}`);
  check("T5.h scanned=402 (incl. malformed + missing-id)", stats.scanned === N + 2, `got ${stats.scanned}`);
  check("T5.i skipped=2", stats.skipped === 2, `got ${stats.skipped}`);
  check("T5.j unknown id is NOT duplicate", c._isDuplicate("git:aaaabbbbcccc:sha-unknown") === false);

  clearLedger("git-log");
}

// ===========================================================================
// T6 — F-GIT_LOG-GITDIR-VALIDATE: broken checkouts are skipped, not errored.
// Production carried 4 unfixable checkouts (an empty .git carcass + 3
// dangling submodule pointer files) that failed `git log` on every poll and
// inflated error_count by 4 per poll (1,701 total) with zero chance of
// healing. The connector must SKIP them (once-per-classification) while the
// valid sibling repo keeps emitting.
// ===========================================================================
console.log("\n--- T6: broken checkouts skipped without error inflation ---");
{
  clearLedger("git-log");
  rmSync(join(TEST_ROOT, "connectors"), { recursive: true, force: true });
  mkdirSync(join(TEST_ROOT, "connectors"), { recursive: true });

  const root = join(TEST_ROOT, "t6-root");
  // Valid repo with 2 user commits.
  const goodRepo = buildSyntheticRepo(join(root, "good-repo"), [
    { subject: "good one", content: "1\n" },
    { subject: "good two", content: "2\n" },
  ], { name: "Operator", email: "operator@example.com" });
  // Empty .git carcass: a directory named .git with nothing inside it.
  const carcass = join(root, "carcass");
  mkdirSync(join(carcass, ".git"), { recursive: true });
  // Dangling submodule pointer FILE (a checkout whose parent was removed):
  // .git is a file whose gitdir target does not exist, and no superproject
  // .git exists above it to resolve against.
  const dangling = join(root, "dangling-submodule");
  mkdirSync(dangling, { recursive: true });
  writeFileSync(join(dangling, ".git"), "gitdir: ../nonexistent/.git/modules/forge-std\n");

  const c = new GitLogConnector({ repoRoots: [root], walkDepth: 1 });
  const r1 = await c.pollOnce();
  check("T6.a discovery still finds all 3 .git-bearing dirs", r1.repos === 3, JSON.stringify(r1));
  check("T6.b errors=0 (broken repos skipped, not GIT_LOG_FAILED)", r1.errors === 0, JSON.stringify(r1));
  check("T6.c appended=2 (valid repo unaffected)", r1.appended === 2, JSON.stringify(r1));

  const cache1 = c.getClassificationCache();
  check("T6.d carcass classified gitdir_unresolvable", cache1[carcass]?.gitdir_unresolvable === true, JSON.stringify(cache1[carcass]));
  check("T6.e dangling pointer classified gitdir_unresolvable", cache1[dangling]?.gitdir_unresolvable === true, JSON.stringify(cache1[dangling]));
  check("T6.f broken entries carry a not-a-git-repository error detail",
    /not a git repository/i.test(cache1[carcass]?.error || "") && /not a git repository/i.test(cache1[dangling]?.error || ""),
    JSON.stringify([cache1[carcass]?.error, cache1[dangling]?.error]));
  check("T6.g valid repo NOT flagged", cache1[goodRepo]?.gitdir_unresolvable !== true, JSON.stringify(cache1[goodRepo]));

  // Second poll: still-broken repos must return the CACHED classification
  // (once-per-classification — same classified_at, no re-log churn) and
  // still contribute zero errors.
  const r2 = await c.pollOnce();
  check("T6.h second poll errors=0", r2.errors === 0, JSON.stringify(r2));
  check("T6.i second poll appended=0", r2.appended === 0, JSON.stringify(r2));
  const cache2 = c.getClassificationCache();
  check("T6.j broken classification NOT re-stamped (classified_at stable)",
    cache2[carcass]?.classified_at === cache1[carcass]?.classified_at &&
    cache2[dangling]?.classified_at === cache1[dangling]?.classified_at,
    JSON.stringify([cache1[carcass]?.classified_at, cache2[carcass]?.classified_at]));

  // Health stays ok — the pre-fix behavior degraded via per-poll tagError.
  const h = c.reportHealth();
  check("T6.k reportHealth status=ok", h.status === "ok", `status=${h.status}`);
  check("T6.l error_rate=0", h.error_rate === 0);

  // Ledger only carries the valid repo's rows.
  const rows = readLedger("git-log");
  // e12: repo_path is the canonical identity, so compare against realpath —
  // see the note at T1.j. The BROKEN repos are the point of this assertion and
  // they contribute nothing either way: an unresolvable git-common-dir degrades
  // to the surface path rather than throwing, and they emit no rows at all.
  check("T6.m all rows from valid repo",
    rows.length === 2 && rows.every((r) => r.raw_content?.repo_path === realpathSync(goodRepo)),
    `got ${rows.length}: ${JSON.stringify(rows.map((r) => r.raw_content?.repo_path))}`);

  clearLedger("git-log");
}

// ===========================================================================
// T7 — F-GIT_LOG-DEDUP-STREAM failure path: a stream read error must fall
// back to bounded tail-dedup LOUDLY (stream_error stat + tagError), never
// silently — the silent fallback is what let 1.1M duplicate rows accumulate
// unnoticed. Pointing sourceLedgerPath at a DIRECTORY makes readSync throw
// EISDIR deterministically (existsSync passes, openSync passes, read fails).
// ===========================================================================
console.log("\n--- T7: stream read failure → loud fallback ---");
{
  rmSync(join(TEST_ROOT, "connectors"), { recursive: true, force: true });
  mkdirSync(join(TEST_ROOT, "connectors"), { recursive: true });

  const dirAsLedger = join(TEST_ROOT, "t7-dir-as-ledger");
  mkdirSync(dirAsLedger, { recursive: true });
  const c = new GitLogConnector({ repoRoots: [join(TEST_ROOT, "no-repos")], walkDepth: 0, sourceLedgerPath: dirAsLedger });

  // The build fails → fallback mode → the base-class tail dedup ALSO throws
  // on the directory (its rethrow-on-IO-error discipline). Either way the
  // call must not silently return false-with-clean-stats.
  let threw = false;
  try { c._isDuplicate("git:aaaabbbbcccc:sha0"); } catch { threw = true; }

  const stats = c.getDedupStats();
  check("T7.a fallback_mode=true after stream failure", stats.fallback_mode === true);
  check("T7.b stream_error carries read-error detail", /^read-error:/.test(stats.stream_error || ""), `got ${stats.stream_error}`);
  check("T7.c base-class tail dedup rethrows on the same IO error", threw === true);

  // tagError is fire-and-forget from the sync build; give it a beat, then
  // confirm the failure reached persisted cursor state (health visibility).
  await new Promise((r) => setTimeout(r, 200));
  const cursor = await c.readCursor();
  check("T7.d tagError recorded dedup_stream_read_failed", cursor?.last_error_kind === "dedup_stream_read_failed", JSON.stringify(cursor));
  check("T7.e error_count incremented", Number.isInteger(cursor?.error_count) && cursor.error_count >= 1, JSON.stringify(cursor));
}

// ===========================================================================
// T8 — e12: LINKED WORKTREES ARE ONE REPO. Exactly one ledger row per commit.
//
// The defect. `git worktree add` gives a repo a SECOND working directory over
// the SAME object store. Discovery correctly finds both surfaces (both carry a
// `.git` entry), but the source_msg_id used to hash the DISCOVERED PATH, so one
// commit minted two different keys and the append-time dedup — which was never
// broken — legitimately let both through. Measured live over the 2026-07-30
// window: 9,821 rows for 1,696 distinct commits = 5.79x, from a 15-surface
// worktree group of ONE repo.
//
// What this test pins, in the order the fix has to satisfy them:
//   a) DISCOVERY IS UNCHANGED — both surfaces are still returned and walked.
//      This is the invariant that the "obvious" fix (stop discovering
//      worktrees) would violate: refs/heads is shared, but the REFLOG is
//      per-worktree, so a surface dropped from discovery loses any commit
//      reachable only from its own reflog.
//   b) BOTH SURFACES AGREE ON IDENTITY — _canonicalRepoIdentity collapses them,
//      so the same commit yields the same source_msg_id whichever surface it is
//      observed through. That is the actual fix: identity, not enforcement.
//   c) EXACTLY ONE ROW PER COMMIT survives to the ledger.
//   d) repo_path is the CANONICAL identity and observed_repo_path carries the
//      surface — provenance demoted from key to attribute, not destroyed. This
//      also fixes project-entity minting, which reads basename(repo_path) and
//      was inventing one project per worktree.
//
// Against the pre-fix implementation this is RED at (c): 2 rows per commit.
// ===========================================================================
console.log("\n--- T8: e12 linked worktree → one identity, one row per commit ---");
{
  clearLedger("git-log");
  rmSync(join(TEST_ROOT, "connectors"), { recursive: true, force: true });
  mkdirSync(join(TEST_ROOT, "connectors"), { recursive: true });

  const group = join(TEST_ROOT, "t8-group");
  mkdirSync(group, { recursive: true });
  const mainRepo = join(group, "repo");
  buildSyntheticRepo(mainRepo, [
    { subject: "worktree case commit one", content: "wt-a\n" },
    { subject: "worktree case commit two", content: "wt-b\n" },
  ], { name: "Operator", email: "operator@example.com" });

  // The linked worktree, as a SIBLING under the walked root so discovery finds
  // it the way it finds any worktree checked out next to its main repo
  // (e.g. example-repo-wt beside example-repo).
  const linked = join(group, "wt");
  const wtRes = spawnSync("git", ["-C", mainRepo, "worktree", "add", "-q", "-b", "side", linked], { encoding: "utf8" });
  check("T8.pre `git worktree add` succeeded", wtRes.status === 0, wtRes.stderr);

  // git resolves through symlinks (/var -> /private/var on macOS), so the
  // canonical identity is the REAL path. Compare against realpath, not the
  // tmpdir string we happened to construct.
  const mainReal = realpathSync(mainRepo);
  const linkedReal = realpathSync(linked);

  const c = new GitLogConnector({ repoRoots: [group], walkDepth: 1 });

  // (a) Discovery still returns BOTH surfaces. The collapse is at identity.
  const discovered = c.discoverRepos();
  check("T8.a discoverRepos returns BOTH surfaces (walk is unchanged)",
    discovered.includes(mainRepo) && discovered.includes(linked),
    JSON.stringify(discovered));

  // (b) Both surfaces resolve to the SAME identity; an unrelated repo does not.
  const idMain = c._canonicalRepoIdentity(mainRepo);
  const idLinked = c._canonicalRepoIdentity(linked);
  check("T8.b identity of the worktree === identity of the main repo",
    idMain === idLinked, `${idMain} vs ${idLinked}`);
  check("T8.c identity IS the main worktree directory",
    idMain === mainReal, `${idMain} vs ${mainReal}`);

  const res = await c.pollOnce();
  const rows = readLedger("git-log");
  const shas = new Set(rows.map((r) => r.raw_content?.commit_hash));

  // (c) One row per commit — the assertion that is RED before the fix.
  check("T8.d exactly one ledger row per commit (2 commits, 2 surfaces)",
    rows.length === 2, `got ${rows.length} rows: ${JSON.stringify(rows.map((r) => r.raw_content?.observed_repo_path))}`);
  check("T8.e no distinct commit was lost", shas.size === 2, `got ${shas.size} distinct shas`);
  check("T8.f appended count agrees with the ledger", res.appended === 2, JSON.stringify(res));
  check("T8.g both surfaces were polled", res.repos === 2, JSON.stringify(res));

  // The identical source_msg_id is WHY only one row landed: recompute the key
  // both surfaces would mint and require them equal, so a future regression
  // that re-splits identity fails here with a readable reason rather than only
  // as a row count.
  const idOf = (p) => c._canonicalRepoIdentity(p);
  check("T8.h same commit ⇒ same source_msg_id from either surface",
    idOf(mainRepo) === idOf(linked) &&
    rows.every((r) => typeof r.source_msg_id === "string" && r.source_msg_id.startsWith("git:")),
    JSON.stringify(rows.map((r) => r.source_msg_id)));

  // (d) Provenance: canonical in repo_path, surface in observed_repo_path.
  check("T8.i raw_content.repo_path is the canonical main-worktree path",
    rows.every((r) => r.raw_content?.repo_path === mainReal),
    JSON.stringify(rows.map((r) => r.raw_content?.repo_path)));
  check("T8.j observed_repo_path carries the actual surface walked",
    rows.every((r) => r.raw_content?.observed_repo_path === mainRepo || r.raw_content?.observed_repo_path === linked),
    JSON.stringify(rows.map((r) => r.raw_content?.observed_repo_path)));

  // Project entity: ONE project for the group, named for the repo — not one
  // per worktree. This is the second, independent defect the collapse fixes.
  const projectSlugs = new Set(
    rows.flatMap((r) => (r.structured_features?.entities || [])
      .filter((e) => e.kind === "project")
      .map((e) => e.canonical_id ?? e.surface)),
  );
  check("T8.k a worktree-sourced commit yields ONE project entity, not one per surface",
    projectSlugs.size === 1, JSON.stringify([...projectSlugs]));
  check("T8.l the project entity is named for the repo, not the worktree dir",
    [...projectSlugs].every((s) => typeof s === "string" && s.includes("repo") && !s.includes("wt")),
    JSON.stringify([...projectSlugs]));

  // per_repo_cursors stays keyed on the DISCOVERED SURFACE: each worktree has
  // its own HEAD and reflog frontier, so collapsing cursors would stall or
  // rewind a walk. One entry per surface, both advanced.
  const cursor = await c.readCursor();
  const cursorKeys = Object.keys(cursor?.per_repo_cursors || {}).sort();
  check("T8.m per_repo_cursors has one entry per DISCOVERED SURFACE (not per identity)",
    cursorKeys.length === 2 && cursorKeys.includes(mainRepo) && cursorKeys.includes(linked),
    JSON.stringify(cursorKeys));
  check("T8.n every surface cursor advanced to a real sha",
    cursorKeys.every((k) => /^[0-9a-f]{40}$/.test(cursor.per_repo_cursors[k])),
    JSON.stringify(cursor?.per_repo_cursors));

  // Cost bound: identity resolution is memoized per poll — one rev-parse per
  // surface, never one per commit.
  check("T8.o identity memo holds at most one entry per discovered surface",
    c._commonDirMemo instanceof Map && c._commonDirMemo.size <= discovered.length,
    `memo=${c._commonDirMemo?.size} surfaces=${discovered.length}`);

  // Re-poll is still idempotent with the collapsed identity.
  const res2 = await c.pollOnce();
  check("T8.p second poll appends nothing", res2.appended === 0, JSON.stringify(res2));
  check("T8.q ledger still holds 2 rows after re-poll", readLedger("git-log").length === 2);

  // Leave no worktree registration behind for the next test's git calls.
  spawnSync("git", ["-C", mainRepo, "worktree", "remove", "--force", linked], { encoding: "utf8" });
}

// ===========================================================================
// T9 — e12 NEGATIVE CASE: two INDEPENDENT repos keep DISTINCT identities.
//
// This is the guard that keeps the fix from being mistaken for global
// commit-hash dedup, and it is the round-20 provenance rule stated as code:
// the same commit present in two genuinely separate repositories is TWO
// events, because the operator did two things.
//
// The fixture makes the commits BYTE-IDENTICAL — same tree, same message, same
// pinned author/committer identity and dates — so both repos produce the SAME
// 40-hex SHA. A fix that keyed on commit_hash alone, or that collapsed by
// basename, would silently drop one of them here. Only the git-common-dir
// distinction survives this test.
// ===========================================================================
console.log("\n--- T9: e12 two independent repos keep distinct identities ---");
{
  clearLedger("git-log");
  rmSync(join(TEST_ROOT, "connectors"), { recursive: true, force: true });
  mkdirSync(join(TEST_ROOT, "connectors"), { recursive: true });

  const group = join(TEST_ROOT, "t9-group");
  mkdirSync(group, { recursive: true });
  const commits = [
    { subject: "shared history commit one", content: "same-a\n", filename: "same-a.txt" },
    { subject: "shared history commit two", content: "same-b\n", filename: "same-b.txt" },
  ];
  const repoA = buildSyntheticRepo(join(group, "alpha"), commits, { name: "Operator", email: "operator@example.com" });
  const repoB = buildSyntheticRepo(join(group, "beta"), commits, { name: "Operator", email: "operator@example.com" });

  const c = new GitLogConnector({ repoRoots: [group], walkDepth: 1 });

  const idA = c._canonicalRepoIdentity(repoA);
  const idB = c._canonicalRepoIdentity(repoB);
  check("T9.a two independent repos have DIFFERENT canonical identities",
    idA !== idB, `${idA} vs ${idB}`);

  await c.pollOnce();
  const rows = readLedger("git-log");
  const shas = new Set(rows.map((r) => r.raw_content?.commit_hash));
  const keys = new Set(rows.map((r) => r.source_msg_id));

  // The fixture's whole point: identical SHAs across two repos.
  check("T9.b the fixture really did produce identical commit hashes in both repos",
    shas.size === 2 && rows.length === 4,
    `rows=${rows.length} distinct_shas=${shas.size}`);
  check("T9.c each repo emitted its own row (4 rows for 2 shared commits)",
    rows.length === 4, `got ${rows.length}`);
  check("T9.d the four rows carry FOUR distinct source_msg_ids",
    keys.size === 4, JSON.stringify([...keys]));
  check("T9.e both repo identities are represented in repo_path",
    new Set(rows.map((r) => r.raw_content?.repo_path)).size === 2,
    JSON.stringify(rows.map((r) => r.raw_content?.repo_path)));
}

// ---------------------------------------------------------------------------
// Production-safety: confirm we never wrote to the real memory.jsonl.
// ---------------------------------------------------------------------------
let prodAfter = null;
try { const st = statSync(PROD_LEDGER); prodAfter = { mtimeMs: st.mtimeMs, size: st.size }; } catch {}
if (prodBefore != null && prodAfter != null) {
  const intact = prodBefore.mtimeMs === prodAfter.mtimeMs && prodBefore.size === prodAfter.size;
  check("PROD-SAFETY production memory.jsonl mtime+size unchanged", intact,
    `before=${JSON.stringify(prodBefore)} after=${JSON.stringify(prodAfter)}`);
}

// ---------------------------------------------------------------------------
// T10 — e12 DEGRADE PATH: an old git must fall back to per-path identity, and
// must NEVER mint an identity out of its own echoed argument.
//
// `git rev-parse` on a version predating --path-format (<2.31) echoes the
// unrecognized option to stdout and STILL EXITS 0, so a linked worktree answers
// with two lines: "--path-format=absolute" then "<parent>/.git". basename()
// splits on "/", so the last segment of that whole string is ".git" and a
// basename-only guard PASSES — after which dirname() yields the newline-bearing
// "--path-format=absolute\n<parent>". That value would be written as repo_path
// into an APPEND-ONLY ledger, so the failure is unrecoverable rather than
// merely wrong. The invariant names "old git" as a case that must degrade to
// per-path identity; without the multi-line rejection it demonstrably does not.
// ---------------------------------------------------------------------------
console.log("\n--- T10: e12 old-git degrade path ---");
{
  const OLD_GIT_STDOUT = "--path-format=absolute\n/Users/alex/Documents/example-repo/.git";

  // The trap itself, pinned so nobody "simplifies" the guard back to basename-only.
  check("T10.a basename() of the two-line answer really is '.git' (the trap)",
    basename(OLD_GIT_STDOUT) === ".git",
    `basename=${JSON.stringify(basename(OLD_GIT_STDOUT))}`);
  check("T10.b dirname() of it really is newline-bearing garbage (the damage)",
    dirname(OLD_GIT_STDOUT).includes("\n"),
    `dirname=${JSON.stringify(dirname(OLD_GIT_STDOUT))}`);

  // The connector must refuse it and fall back to the walked path unchanged.
  const conn = new GitLogConnector({ repoRoots: [], walkDepth: 0 });
  conn._commonDirMemo = new Map([["/some/worktree", null]]);
  const degraded = conn._canonicalRepoIdentity("/some/worktree");
  check("T10.c unresolvable common-dir degrades to the repoPath itself",
    degraded === "/some/worktree", `got ${JSON.stringify(degraded)}`);

  // And the identity never contains a newline, whatever git said.
  conn._commonDirMemo = new Map([["/some/worktree2", OLD_GIT_STDOUT]]);
  const fromGarbage = conn._canonicalRepoIdentity("/some/worktree2");
  check("T10.d an identity never carries a newline into the ledger",
    !fromGarbage.includes("\n"),
    `got ${JSON.stringify(fromGarbage)}`);
}

// ===========================================================================
// T12 — D1 gitlog-ref-tip-cursor: a quiet poll walks ZERO commits.
//
// Pre-fix the frontier was the single range `<cursor>..HEAD` under
// `--all --reflog`, which excludes ONE lineage while the walk starts from every
// ref and reflog entry: an unchanged repo re-walked its whole side-branch and
// reflog history every 900 s (36,605 commits per quiet poll across the
// runtime population, measured 2026-09-09), classified each one, and emitted
// phantom recordDrop telemetry before the dedup. Post-fix every walk start
// point (`git rev-list --no-walk --all --reflog`) is persisted per surface in
// state.heavy.json and negated via `--ignore-missing --stdin`.
//
// Each sub-step is a guard against the data-loss mode this ordering forbids
// (a tip persisted before its commit was walked): side-branch commits (c),
// an amended reflog-only commit (d) and a commit inside a linked worktree (g)
// must each still be appended on the very next poll, and the poll after each
// must walk 0.
// ===========================================================================
console.log("\n--- T12: D1 tip frontier — quiet poll walks 0 ---");
{
  clearLedger("git-log");
  rmSync(join(TEST_ROOT, "connectors"), { recursive: true, force: true });
  mkdirSync(join(TEST_ROOT, "connectors"), { recursive: true });

  // A group root with walkDepth 1 so the linked worktree in (g) is discovered
  // as a sibling surface, exactly as T8 does.
  const group = join(TEST_ROOT, "t12-group");
  mkdirSync(group, { recursive: true });
  const repoDir = join(group, "repo");
  const author = { name: "Operator", email: "operator@example.com" };
  buildSyntheticRepo(repoDir, [
    { subject: "tip frontier commit one", content: "tf-a\n" },
    { subject: "tip frontier commit two", content: "tf-b\n" },
  ], author);

  // buildSyntheticRepo's env recipe, reused for the commits made mid-test so
  // the fixture stays deterministic.
  const baseEpoch = 1717200000;
  let epochTick = 100;
  function pinnedEnv() {
    const epoch = baseEpoch + (epochTick++) * 60;
    return {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_DATE: `${epoch} +0000`,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
      GIT_COMMITTER_DATE: `${epoch} +0000`,
    };
  }
  function gitIn(dir, args, env) {
    const res = spawnSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
    return res.stdout;
  }
  function commitIn(dir, filename, content, subject) {
    writeFileSync(join(dir, filename), content);
    gitIn(dir, ["add", filename]);
    gitIn(dir, ["commit", "-q", "-m", subject], pinnedEnv());
  }

  // A ticking clock so "the stamp did not move" is a real assertion rather
  // than two polls landing in the same millisecond.
  let clockTick = 0;
  const now = () => new Date(1717300000000 + (clockTick++) * 1000).toISOString();
  const mk = () => new GitLogConnector({ repoRoots: [group], walkDepth: 1, now });
  const readHeavy = (c) => JSON.parse(readFileSync(c.heavyCursorPath, "utf8"));
  // hexLen: 40 for SHA-1 repos (every fixture but T12.i), 64 for the SHA-256
  // object format (D3) — the sha256 assertion must not reuse a 40-only predicate.
  const isTipList = (v, hexLen = 40) =>
    Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && s.length === hexLen && /^[0-9a-f]+$/.test(s));
  const isSortedUnique = (v) => new Set(v).size === v.length && v.every((s, i) => i === 0 || v[i - 1] < s);

  // (a) First poll: the two user commits land; the walk covered at least them.
  const c = mk();
  const r1 = await c.pollOnce();
  check("T12.a1 poll 1 appended=2", r1.appended === 2, JSON.stringify(r1));
  check("T12.a2 poll 1 walked>=2", Number.isInteger(r1.walked) && r1.walked >= 2, JSON.stringify(r1));
  check("T12.a3 pollOnce returns {appended, errors, repos, walked}",
    ["appended", "errors", "repos", "walked"].every((k) => k in r1), JSON.stringify(Object.keys(r1)));
  const state1 = await c.readCursor();

  // (b) Nothing changed: walk 0, append 0, error 0, and the staleness stamp
  // is carried forward byte-for-byte.
  const r2 = await c.pollOnce();
  check("T12.b1 quiet poll walked=0", r2.walked === 0, JSON.stringify(r2));
  check("T12.b2 quiet poll appended=0", r2.appended === 0, JSON.stringify(r2));
  check("T12.b3 quiet poll errors=0", r2.errors === 0, JSON.stringify(r2));
  const state2 = await c.readCursor();
  check("T12.b4 last_cursor_advance_ts unchanged by a quiet poll",
    typeof state1.last_cursor_advance_ts === "string"
      && state2.last_cursor_advance_ts === state1.last_cursor_advance_ts,
    `${state1.last_cursor_advance_ts} -> ${state2.last_cursor_advance_ts}`);
  check("T12.b5 last_polled_ts still advanced (we ran)",
    state2.last_polled_ts !== state1.last_polled_ts,
    `${state1.last_polled_ts} -> ${state2.last_polled_ts}`);

  // (c) Side branch: `--all` still covers it.
  gitIn(repoDir, ["checkout", "-q", "-b", "feature"]);
  commitIn(repoDir, "feat-a.txt", "feat-a\n", "feature commit one");
  commitIn(repoDir, "feat-b.txt", "feat-b\n", "feature commit two");
  gitIn(repoDir, ["checkout", "-q", "main"]);
  const r3 = await c.pollOnce();
  check("T12.c1 side-branch commits appended=2", r3.appended === 2, JSON.stringify(r3));
  check("T12.c2 side-branch poll errors=0", r3.errors === 0, JSON.stringify(r3));
  const r4 = await c.pollOnce();
  check("T12.c3 poll after side-branch walked=0", r4.walked === 0 && r4.appended === 0, JSON.stringify(r4));

  // (d) Amend on the feature branch: the new commit is reachable from the
  // branch tip; the old one survives only in the reflog. `--reflog` still
  // covers the class and the amended commit is one new row.
  gitIn(repoDir, ["checkout", "-q", "feature"]);
  gitIn(repoDir, ["commit", "-q", "--amend", "-m", "amended feature commit"], pinnedEnv());
  gitIn(repoDir, ["checkout", "-q", "main"]);
  const r5 = await c.pollOnce();
  check("T12.d1 amended commit appended=1", r5.appended === 1, JSON.stringify(r5));
  check("T12.d2 amend poll errors=0", r5.errors === 0, JSON.stringify(r5));
  const r6 = await c.pollOnce();
  check("T12.d3 poll after amend walked=0", r6.walked === 0 && r6.appended === 0, JSON.stringify(r6));

  // (e) Simulated `--once` restart: a fresh instance reads the frontier from
  // the sidecar and walks 0. The map lives in state.heavy.json, NOT state.json.
  const c2 = mk();
  const r7 = await c2.pollOnce();
  check("T12.e1 fresh instance walks 0 on an unchanged repo", r7.walked === 0 && r7.appended === 0, JSON.stringify(r7));
  check("T12.e2 state.heavy.json exists", existsSync(c2.heavyCursorPath), c2.heavyCursorPath);
  const heavy = readHeavy(c2);
  const tipsE = heavy.per_repo_ref_tips?.[repoDir];
  check("T12.e3 per_repo_ref_tips[repoDir] is a non-empty array of 40-hex shas",
    isTipList(tipsE), JSON.stringify(tipsE));
  check("T12.e4 tip list is sorted and unique",
    Array.isArray(tipsE) && new Set(tipsE).size === tipsE.length
      && tipsE.every((s, i) => i === 0 || tipsE[i - 1] < s),
    JSON.stringify(tipsE));
  const light = JSON.parse(readFileSync(c2.cursorPath, "utf8"));
  check("T12.e5 state.json does NOT carry per_repo_ref_tips",
    !Object.prototype.hasOwnProperty.call(light, "per_repo_ref_tips"), JSON.stringify(Object.keys(light)));
  check("T12.e6 per_repo_cursors stays a single 40-hex sha keyed by surface",
    /^[0-9a-f]{40}$/.test(light.per_repo_cursors?.[repoDir] || ""), JSON.stringify(light.per_repo_cursors));

  // (f) A tip sha that no longer exists (reflog expiry between polls) must
  // not error the walk: `--ignore-missing` precedes `--stdin`.
  heavy.per_repo_ref_tips[repoDir] = [...tipsE, "f".repeat(40)];
  writeFileSync(c2.heavyCursorPath, JSON.stringify(heavy) + "\n");
  const r8 = await c2.pollOnce();
  check("T12.f1 bogus tip: errors=0", r8.errors === 0, JSON.stringify(r8));
  check("T12.f2 bogus tip: walked=0", r8.walked === 0, JSON.stringify(r8));

  // (g) Linked worktree (T8 recipe): a commit made in it is appended once,
  // then the next poll walks 0 on BOTH surfaces.
  const linked = join(group, "wt");
  const wtRes = spawnSync("git", ["-C", repoDir, "worktree", "add", "-q", "-b", "side", linked], { encoding: "utf8" });
  check("T12.g0 `git worktree add` succeeded", wtRes.status === 0, wtRes.stderr);
  commitIn(linked, "wt-only.txt", "wt-only\n", "commit made inside the linked worktree");
  const r9 = await c2.pollOnce();
  check("T12.g1 worktree commit appended=1", r9.appended === 1, JSON.stringify(r9));
  check("T12.g2 worktree poll errors=0 and both surfaces polled", r9.errors === 0 && r9.repos === 2, JSON.stringify(r9));
  const r10 = await c2.pollOnce();
  check("T12.g3 poll after worktree commit walked=0", r10.walked === 0 && r10.appended === 0, JSON.stringify(r10));
  const heavyG = readHeavy(c2);
  check("T12.g4 the linked worktree has its own tip entry keyed by surface",
    isTipList(heavyG.per_repo_ref_tips?.[linked]), JSON.stringify(Object.keys(heavyG.per_repo_ref_tips || {})));
  spawnSync("git", ["-C", repoDir, "worktree", "remove", "--force", linked], { encoding: "utf8" });

  // (h) Zero-commit repo: persists [] and, on a fresh instance, walks 0
  // WITHOUT taking the cursor-missing branch (no dedup-Set build).
  const emptyDir = join(TEST_ROOT, "repo-t12-empty");
  mkdirSync(emptyDir, { recursive: true });
  gitIn(emptyDir, ["init", "-q", "-b", "main"]);
  const cE1 = new GitLogConnector({ repoRoots: [emptyDir], walkDepth: 0, now });
  const rE1 = await cE1.pollOnce();
  check("T12.h1 zero-commit repo poll 1 errors=0 walked=0",
    rE1.errors === 0 && rE1.walked === 0 && rE1.repos === 1, JSON.stringify(rE1));
  const heavyH = readHeavy(cE1);
  check("T12.h2 zero-commit repo persists per_repo_ref_tips[repoDir] === []",
    Array.isArray(heavyH.per_repo_ref_tips?.[emptyDir]) && heavyH.per_repo_ref_tips[emptyDir].length === 0,
    JSON.stringify(heavyH.per_repo_ref_tips?.[emptyDir]));
  const cE2 = new GitLogConnector({ repoRoots: [emptyDir], walkDepth: 0, now });
  check("T12.h3 fresh instance starts with the dedup Set unbuilt", cE2._dedupSetBuilt === false);
  const rE2 = await cE2.pollOnce();
  check("T12.h4 zero-commit repo poll 2 walked=0 errors=0",
    rE2.walked === 0 && rE2.errors === 0, JSON.stringify(rE2));
  check("T12.h5 the quiet path never built the dedup Set",
    cE2._dedupSetBuilt === false, `_dedupSetBuilt=${cE2._dedupSetBuilt}`);

  // (i) D3 gitlog-frontier-completeness — SHA-256 object format. `git
  // rev-list` prints 64-hex shas there; the original 40-hex-only filter in
  // _repoWalkTips dropped every line, so the surface persisted `[]` and was
  // walked UNBOUNDED on every poll (probed 3/3/3 on this fixture before the
  // fix). buildSyntheticRepo hardcodes the sha1 `git init`, so the fixture
  // is inlined with the same sentinel + 2 user commits. A git too old for
  // `--object-format=sha256` skips the sub-block with a logged notice.
  const groupI = join(TEST_ROOT, "t12i-group");
  const repoI = join(groupI, "repo");
  mkdirSync(repoI, { recursive: true });
  let sha256Ok = true;
  try {
    gitIn(repoI, ["init", "-q", "-b", "main", "--object-format=sha256"]);
  } catch (err) {
    sha256Ok = false;
    console.log(`  T12.i SKIPPED — this git cannot \`init --object-format=sha256\`: ${String(err.message).split("\n")[0]}`);
  }
  if (sha256Ok) {
    commitIn(repoI, ".git-fixture-seed", "seed\n", "Initial commit");
    commitIn(repoI, "sha256-a.txt", "sha256-a\n", "sha256 commit one");
    commitIn(repoI, "sha256-b.txt", "sha256-b\n", "sha256 commit two");
    check("T12.i0 sha256 fixture HEAD is a 64-hex sha",
      /^[0-9a-f]{64}$/.test(gitIn(repoI, ["rev-parse", "HEAD"]).trim()));
    const cI1 = new GitLogConnector({ repoRoots: [groupI], walkDepth: 1, now });
    const rI1 = await cI1.pollOnce();
    check("T12.i1 sha256 poll 1 appended=2 walked>=2 errors=0",
      rI1.appended === 2 && rI1.walked >= 2 && rI1.errors === 0, JSON.stringify(rI1));
    const cI2 = new GitLogConnector({ repoRoots: [groupI], walkDepth: 1, now });
    const rI2 = await cI2.pollOnce();
    check("T12.i2 sha256 poll 2 (fresh instance) walked=0 appended=0 errors=0",
      rI2.walked === 0 && rI2.appended === 0 && rI2.errors === 0, JSON.stringify(rI2));
    const tipsI = readHeavy(cI2).per_repo_ref_tips?.[repoI];
    check("T12.i3 per_repo_ref_tips[repoDir] is a non-empty sorted unique list of 64-hex shas",
      isTipList(tipsI, 64) && isSortedUnique(tipsI), JSON.stringify(tipsI));
    check("T12.i4 sha256 quiet poll never built the dedup Set",
      cI2._dedupSetBuilt === false, `_dedupSetBuilt=${cI2._dedupSetBuilt}`);
  }

  // (j) D3 — a bounded first run must NOT persist the frontier. Two
  // lineages: main = sentinel + m1..m3, side (branched from HEAD~2 = m1) =
  // s1..s2; 6 commits per `rev-list --all --count`, 5 user. With
  // logMaxCommitsFirstRun: 3 (the existing ctor seam) the first listing
  // returns only the three newest (s2, s1, m3). Before the fix the full tip
  // frontier (6 shas) was persisted after it, so m1 and m2 were negated
  // unseen on every later poll (probed 3/0/0, 3 of 5 appended). Post-fix
  // the first run persists `[]`, poll 2 walks every lineage once (dedup
  // absorbs s2/s1/m3), poll 3 walks 0 — pre-D1 completeness, restored.
  const groupJ = join(TEST_ROOT, "t12j-group");
  const repoJ = join(groupJ, "repo");
  mkdirSync(repoJ, { recursive: true });
  gitIn(repoJ, ["init", "-q", "-b", "main"]);
  commitIn(repoJ, ".git-fixture-seed", "seed\n", "Initial commit");
  commitIn(repoJ, "m1.txt", "m1\n", "main commit one");
  commitIn(repoJ, "m2.txt", "m2\n", "main commit two");
  commitIn(repoJ, "m3.txt", "m3\n", "main commit three");
  gitIn(repoJ, ["checkout", "-q", "-b", "side", "HEAD~2"]);
  commitIn(repoJ, "s1.txt", "s1\n", "side commit one");
  commitIn(repoJ, "s2.txt", "s2\n", "side commit two");
  gitIn(repoJ, ["checkout", "-q", "main"]);
  const totalJ = Number(gitIn(repoJ, ["rev-list", "--all", "--count"]).trim());
  check("T12.j0 two-lineage fixture has 6 commits (5 user + sentinel)", totalJ === 6, String(totalJ));
  const mkJ = () => new GitLogConnector({ repoRoots: [groupJ], walkDepth: 1, now, logMaxCommitsFirstRun: 3 });
  // observed_repo_path is the discovered surface (T1.j2); repo_path is the
  // realpath'd canonical identity, which differs under a /var → /private/var
  // tmpdir.
  const rowsForJ = () => readLedger("git-log").filter((row) => row?.raw_content?.observed_repo_path === repoJ).length;
  const cJ1 = mkJ();
  const rJ1 = await cJ1.pollOnce();
  check("T12.j1 bounded first run walked=3 appended=3 errors=0",
    rJ1.walked === 3 && rJ1.appended === 3 && rJ1.errors === 0, JSON.stringify(rJ1));
  const tipsJ1 = readHeavy(cJ1).per_repo_ref_tips?.[repoJ];
  check("T12.j2 bounded first run persists per_repo_ref_tips[repoDir] === [] (frontier deferred)",
    Array.isArray(tipsJ1) && tipsJ1.length === 0, JSON.stringify(tipsJ1));
  const cJ2 = mkJ();
  const rJ2 = await cJ2.pollOnce();
  check("T12.j3 poll 2 walks every lineage (rev-list --all --count = 6) and appends the remaining 2",
    rJ2.walked === totalJ && rJ2.appended === 2 && rJ2.errors === 0, JSON.stringify(rJ2));
  const cJ3 = mkJ();
  const rJ3 = await cJ3.pollOnce();
  check("T12.j4 poll 3 walked=0 appended=0 errors=0 without building the dedup Set",
    rJ3.walked === 0 && rJ3.appended === 0 && rJ3.errors === 0 && cJ3._dedupSetBuilt === false,
    `${JSON.stringify(rJ3)} _dedupSetBuilt=${cJ3._dedupSetBuilt}`);
  const tipsJ3 = readHeavy(cJ3).per_repo_ref_tips?.[repoJ];
  check("T12.j5 tips after poll 3 are a non-empty sorted unique list of 40-hex shas",
    isTipList(tipsJ3) && isSortedUnique(tipsJ3), JSON.stringify(tipsJ3));
  check("T12.j6 appended across the three polls === 5 === user commits === ledger rows for the repo",
    rJ1.appended + rJ2.appended + rJ3.appended === 5 && rowsForJ() === 5,
    `${rJ1.appended}+${rJ2.appended}+${rJ3.appended} rows=${rowsForJ()}`);

  // (j7) Control — the `commits.length >= cap` half of the guard. A first
  // run whose listing returned FEWER commits than the cap was complete and
  // must persist real tips at once, or every small repo re-walks on poll 2
  // (the T12.b1 regression). Sentinel + 2 user commits = 3 listings, so the
  // cap is 4 here: under cap 3 the same repo lists 3 >= 3 and correctly
  // takes the deferral, which is (j), not a control.
  const groupK = join(TEST_ROOT, "t12k-group");
  const repoK = join(groupK, "repo");
  mkdirSync(repoK, { recursive: true });
  gitIn(repoK, ["init", "-q", "-b", "main"]);
  commitIn(repoK, ".git-fixture-seed", "seed\n", "Initial commit");
  commitIn(repoK, "k1.txt", "k1\n", "control commit one");
  commitIn(repoK, "k2.txt", "k2\n", "control commit two");
  const mkK = () => new GitLogConnector({ repoRoots: [groupK], walkDepth: 1, now, logMaxCommitsFirstRun: 4 });
  const cK1 = mkK();
  const rK1 = await cK1.pollOnce();
  const tipsK1 = readHeavy(cK1).per_repo_ref_tips?.[repoK];
  check("T12.j7 control: a first run below the cap (3 < 4) appends 2 and persists real tips at once",
    rK1.walked === 3 && rK1.appended === 2 && rK1.errors === 0 && isTipList(tipsK1),
    `${JSON.stringify(rK1)} tips=${JSON.stringify(tipsK1)}`);
  const cK2 = mkK();
  const rK2 = await cK2.pollOnce();
  check("T12.j8 control: poll 2 walked=0 appended=0 without building the dedup Set",
    rK2.walked === 0 && rK2.appended === 0 && rK2.errors === 0 && cK2._dedupSetBuilt === false,
    `${JSON.stringify(rK2)} _dedupSetBuilt=${cK2._dedupSetBuilt}`);

  // (k) D3 fix (4) — the legacy one-lineage migration's pruned-cursor retry.
  // Seed exactly the state that path sees: a `per_repo_cursors` sha that is
  // no longer in the repo (rebased/pruned), NO tips entry, and prior ledger
  // rows for the surface (the (j) rows). pollOnce passes
  // `repoHasPriorHistory: false` because the surface has a cursor (the quiet
  // path must never build the Set), `<sha>..HEAD` fails, and the retry must
  // DERIVE the hint from the Set — walking full history (6), not the `-n 3`
  // cap. Before the fix the retry forwarded `opts` unchanged and took the
  // bounded branch.
  const lightL = JSON.parse(readFileSync(cJ3.cursorPath, "utf8"));
  lightL.per_repo_cursors[repoJ] = "f".repeat(40);
  writeFileSync(cJ3.cursorPath, JSON.stringify(lightL) + "\n");
  const heavyL = readHeavy(cJ3);
  delete heavyL.per_repo_ref_tips[repoJ];
  writeFileSync(cJ3.heavyCursorPath, JSON.stringify(heavyL) + "\n");
  const cL1 = mkJ();
  const rL1 = await cL1.pollOnce();
  check("T12.k0 pruned legacy cursor + no tips + prior rows: the retry walks FULL history (6), not the -n 3 cap; appends 0",
    rL1.walked === totalJ && rL1.appended === 0 && rL1.errors === 0 && cL1._dedupSetBuilt === true,
    `${JSON.stringify(rL1)} _dedupSetBuilt=${cL1._dedupSetBuilt}`);
  const cL2 = mkJ();
  const rL2 = await cL2.pollOnce();
  check("T12.k1 that migration walk was unbounded, so real tips were persisted: the next poll walks 0 without the Set",
    rL2.walked === 0 && rL2.appended === 0 && rL2.errors === 0 && cL2._dedupSetBuilt === false
      && isTipList(readHeavy(cL2).per_repo_ref_tips?.[repoJ]),
    `${JSON.stringify(rL2)} _dedupSetBuilt=${cL2._dedupSetBuilt} rows=${rowsForJ()}`);

  // D5 fixtures below reuse the (j) shape: main = sentinel + m1..m3, side
  // (from HEAD~2 = m1) = s1..s2; 6 commits, 5 user. Optional multi-KB bodies
  // per commit (`-m subject -m body`, under BODY_MAX_BYTES so parsing is
  // unaffected) let (m) make the UNBOUNDED listing exceed a buffer that the
  // bounded `-n 3` listing (s2, s1, m3) does not.
  const twoLineageRepo = (group, bodies = {}) => {
    const repo = join(group, "repo");
    mkdirSync(repo, { recursive: true });
    gitIn(repo, ["init", "-q", "-b", "main"]);
    const commitWithBody = (filename, content, subject, body) => {
      writeFileSync(join(repo, filename), content);
      gitIn(repo, ["add", filename]);
      gitIn(repo, ["commit", "-q", "-m", subject, ...(body ? ["-m", body] : [])], pinnedEnv());
    };
    commitWithBody(".git-fixture-seed", "seed\n", "Initial commit");
    commitWithBody("m1.txt", "m1\n", "main commit one", bodies.m1);
    commitWithBody("m2.txt", "m2\n", "main commit two", bodies.m2);
    commitWithBody("m3.txt", "m3\n", "main commit three", bodies.m3);
    gitIn(repo, ["checkout", "-q", "-b", "side", "HEAD~2"]);
    commitWithBody("s1.txt", "s1\n", "side commit one", bodies.s1);
    commitWithBody("s2.txt", "s2\n", "side commit two", bodies.s2);
    gitIn(repo, ["checkout", "-q", "main"]);
    return { repo, total: Number(gitIn(repo, ["rev-list", "--all", "--count"]).trim()) };
  };
  const rowsFor = (repo) => readLedger("git-log").filter((row) => row?.raw_content?.observed_repo_path === repo).length;
  const readLight = (c) => JSON.parse(readFileSync(c.cursorPath, "utf8"));
  // Capture console.error lines emitted during fn(); the dedup-build notice
  // goes to console.log, so only real stderr lines land here.
  const captureStderr = async (fn) => {
    const lines = [];
    const orig = console.error;
    console.error = (...a) => { lines.push(a.map(String).join(" ")); };
    try { return [await fn(), lines]; } finally { console.error = orig; }
  };

  // (l) D5 — the first-run bound is tested on the RAW record count. Pre-D5
  // pollOnce compared commits.length (the PARSED count) with the cap, so a
  // listing that filled the cap but lost one record in _parseGitLogOutput
  // (_parseMetadataLine's `parts.length < 6` drop, or the metaIdx backward
  // search misfiling a >=5-pipe body line) read as "below the cap": real
  // tips were persisted after a 2-of-3 walk and the dropped record's lineage
  // was negated unseen forever (reproduced: polls 2 and 3 walked 0, 2 of 5
  // user commits on disk). The poll-1 instance wraps the parser to drop one
  // commit; the RAW count is still 3 >= 3, so the frontier must defer.
  const groupLd = join(TEST_ROOT, "t12l-group");
  const { repo: repoLd, total: totalLd } = twoLineageRepo(groupLd);
  const mkLd = () => new GitLogConnector({ repoRoots: [groupLd], walkDepth: 1, now, logMaxCommitsFirstRun: 3 });
  const cLd1 = mkLd();
  const origParse = cLd1._parseGitLogOutput;
  cLd1._parseGitLogOutput = function (raw) { return origParse.call(this, raw).slice(1); };
  const rLd1 = await cLd1.pollOnce();
  const tipsLd1 = readHeavy(cLd1).per_repo_ref_tips?.[repoLd];
  check("T12.l1 parse-drop under the cap: poll 1 walked=2 appended=2 errors=0 yet per_repo_ref_tips[repo] === [] (raw count 3 >= 3 defers)",
    rLd1.walked === 2 && rLd1.appended === 2 && rLd1.errors === 0 && Array.isArray(tipsLd1) && tipsLd1.length === 0,
    `${JSON.stringify(rLd1)} tips=${JSON.stringify(tipsLd1)}`);
  const cLd2 = mkLd();
  const rLd2 = await cLd2.pollOnce();
  check("T12.l2 poll 2 (fresh instance) walks every lineage (rev-list --all --count = 6) and appends the remaining 3",
    rLd2.walked === totalLd && rLd2.appended === 3 && rLd2.errors === 0, JSON.stringify(rLd2));
  const cLd3 = mkLd();
  const rLd3 = await cLd3.pollOnce();
  check("T12.l3 poll 3 walked=0 appended=0 errors=0 without building the dedup Set",
    rLd3.walked === 0 && rLd3.appended === 0 && rLd3.errors === 0 && cLd3._dedupSetBuilt === false,
    `${JSON.stringify(rLd3)} _dedupSetBuilt=${cLd3._dedupSetBuilt}`);
  check("T12.l4 ledger rows for the repo === 5 === user commits (the dropped record was recovered by the deferred walk)",
    rowsFor(repoLd) === totalLd - 1, `rows=${rowsFor(repoLd)}`);

  // (m) D5 — ENOBUFS on the deferred walk. Bodies of ~3 KB on m1 and m2
  // (outside the bounded top-3 listing) make the unbounded listing exceed a
  // logMaxBufferBytes of 5,000 that the bounded and the legacy range
  // listings stay under (m0 pins the arithmetic). Pre-D5, tips [] + no
  // cursor threw `exit null` (errors=1, tips [] again) on EVERY poll with no
  // stderr line; tips [] + a legacy cursor fell to the range walk with
  // errors=0 and persisted real tips silently (3 of 5 user commits on disk,
  // nobody told). Post-D5 both are loud (one stderr line naming ENOBUFS and
  // the repo, errors=1, last_error_kind git_log_enobufs), the PRE-WALK
  // frontier is persisted exactly once, and the next default-buffer poll is
  // quiet.
  const bigBody = (tag) => `${tag} body line\n`.repeat(200);
  const groupEb = join(TEST_ROOT, "t12m-group");
  const { repo: repoEb, total: totalEb } = twoLineageRepo(groupEb, { m1: bigBody("m1"), m2: bigBody("m2") });
  const SMALL_BUFFER = 5000;
  const listingFmt = "--pretty=format:%H|%aI|%an|%ae|%s|%P%n¶¶¶%n%B%n¶¶¶§§§";
  const boundedBytes = gitIn(repoEb, ["log", listingFmt, "--all", "--reflog", "--numstat", "-n", "3"]).length;
  const fullBytes = gitIn(repoEb, ["log", listingFmt, "--all", "--reflog", "--numstat"]).length;
  const rangeBytes = gitIn(repoEb, ["log", listingFmt, "--all", "--reflog", "--numstat", "HEAD~1..HEAD"]).length;
  check("T12.m0 fixture arithmetic: bounded and HEAD~1..HEAD listings fit the small buffer, the full listing does not",
    boundedBytes < SMALL_BUFFER && rangeBytes < SMALL_BUFFER && fullBytes > SMALL_BUFFER,
    `bounded=${boundedBytes} range=${rangeBytes} full=${fullBytes} buffer=${SMALL_BUFFER}`);
  const mkEb = (extra = {}) => new GitLogConnector({ repoRoots: [groupEb], walkDepth: 1, now, logMaxCommitsFirstRun: 3, ...extra });
  const cEb1 = mkEb();
  const rEb1 = await cEb1.pollOnce();
  check("T12.m1 poll 1 (default buffer): bounded first run walked=3 appended=3 and defers the frontier ([])",
    rEb1.walked === 3 && rEb1.appended === 3 && rEb1.errors === 0
      && Array.isArray(readHeavy(cEb1).per_repo_ref_tips?.[repoEb]) && readHeavy(cEb1).per_repo_ref_tips[repoEb].length === 0,
    JSON.stringify(rEb1));
  // New-repo shape: tips [] and NO legacy cursor — the walk negates nothing,
  // so the `full` fallback would be the identical listing; D5 returns []
  // at once with the marker instead of recursing into a second ENOBUFS.
  const lightEb = readLight(cEb1);
  delete lightEb.per_repo_cursors[repoEb];
  writeFileSync(cEb1.cursorPath, JSON.stringify(lightEb) + "\n");
  const cEb2 = mkEb({ logMaxBufferBytes: SMALL_BUFFER });
  const [rEb2, errEb2] = await captureStderr(() => cEb2.pollOnce());
  const enobufsLines = (lines) => lines.filter((l) => l.includes("ENOBUFS") && l.includes(repoEb));
  check("T12.m2 small buffer, tips [] + no cursor: exactly one stderr line names ENOBUFS and the repo path",
    errEb2.length === 1 && enobufsLines(errEb2).length === 1, JSON.stringify(errEb2));
  check("T12.m3 that poll returns errors=1 walked=0 appended=0, last_error_kind=git_log_enobufs, and never built the dedup Set",
    rEb2.errors === 1 && rEb2.walked === 0 && rEb2.appended === 0
      && readLight(cEb2).last_error_kind === "git_log_enobufs" && cEb2._dedupSetBuilt === false,
    `${JSON.stringify(rEb2)} kind=${readLight(cEb2).last_error_kind} _dedupSetBuilt=${cEb2._dedupSetBuilt}`);
  const tipsEb2 = readHeavy(cEb2).per_repo_ref_tips?.[repoEb];
  check("T12.m4 the PRE-WALK frontier was persisted (non-empty sorted unique 40-hex), not [] (no endless re-spawn) and not the deferral",
    isTipList(tipsEb2) && isSortedUnique(tipsEb2), JSON.stringify(tipsEb2));
  const cEb3 = mkEb();
  const rEb3 = await cEb3.pollOnce();
  check("T12.m5 poll 3 (default buffer) walked=0 appended=0 errors=0 without the Set — the surface is frozen, visibly (3 of 5 user rows on disk)",
    rEb3.walked === 0 && rEb3.appended === 0 && rEb3.errors === 0 && cEb3._dedupSetBuilt === false && rowsFor(repoEb) === 3,
    `${JSON.stringify(rEb3)} _dedupSetBuilt=${cEb3._dedupSetBuilt} rows=${rowsFor(repoEb)}`);
  // Legacy-cursor variant: tips [] (the D3 deferral) and a per_repo_cursors
  // sha at HEAD~1. The tips walk ENOBUFS's, then the existing range fallback
  // (`HEAD~1..HEAD`, a DIFFERENT listing that fits) runs unchanged — walked
  // is that range's count, strictly between 0 and the full walk — and the
  // poll still counts the error and emits the one stderr line. The tips
  // entry is kept as `[]` rather than deleted: without a tips entry the
  // surface takes the range branch FIRST and no ENOBUFS can occur.
  const heavyEb = readHeavy(cEb3);
  heavyEb.per_repo_ref_tips[repoEb] = [];
  writeFileSync(cEb3.heavyCursorPath, JSON.stringify(heavyEb) + "\n");
  const lightEb2 = readLight(cEb3);
  lightEb2.per_repo_cursors = { ...(lightEb2.per_repo_cursors || {}), [repoEb]: gitIn(repoEb, ["rev-parse", "HEAD~1"]).trim() };
  writeFileSync(cEb3.cursorPath, JSON.stringify(lightEb2) + "\n");
  const cEb4 = mkEb({ logMaxBufferBytes: SMALL_BUFFER });
  const [rEb4, errEb4] = await captureStderr(() => cEb4.pollOnce());
  check("T12.m6 legacy-cursor variant: the tips walk ENOBUFS's (one stderr line), the range fallback still runs (0 < walked < full), errors=1 appended=0",
    errEb4.length === 1 && enobufsLines(errEb4).length === 1 && errEb4[0].includes("falling back")
      && rEb4.errors === 1 && rEb4.walked > 0 && rEb4.walked < totalEb && rEb4.appended === 0,
    `${JSON.stringify(rEb4)} stderr=${JSON.stringify(errEb4)}`);
  check("T12.m7 legacy-cursor variant persisted real tips (the pre-walk snapshot) and the next default poll walks 0",
    isTipList(readHeavy(cEb4).per_repo_ref_tips?.[repoEb]) && (await mkEb().pollOnce()).walked === 0,
    JSON.stringify(readHeavy(cEb4).per_repo_ref_tips?.[repoEb]));
  // No-fallback throw: a full recovery walk (no tips, no cursor, prior
  // history) that ENOBUFS's has nothing different to retry — the error must
  // name ENOBUFS and carry code GIT_LOG_ENOBUFS, not `exit null`.
  const cEb5 = mkEb({ logMaxBufferBytes: SMALL_BUFFER });
  let thrown = null;
  const walkInfoEb5 = {};
  const [, errEb5] = await captureStderr(async () => {
    try { cEb5._gitLogForRepo(repoEb, null, { repoHasPriorHistory: true, walkInfo: walkInfoEb5 }); }
    catch (err) { thrown = err; }
  });
  check("T12.m8 the no-fallback throw carries err.code === 'GIT_LOG_ENOBUFS', names ENOBUFS (no more 'exit null'), and walkInfo carries the marker",
    thrown && thrown.code === "GIT_LOG_ENOBUFS" && /ENOBUFS/.test(thrown.message) && !/exit null/.test(thrown.message)
      && walkInfoEb5.enobufs && walkInfoEb5.enobufs.mode === "full" && walkInfoEb5.enobufs.bytes === SMALL_BUFFER
      && errEb5.length === 1,
    `code=${thrown && thrown.code} msg=${thrown && thrown.message} walkInfo=${JSON.stringify(walkInfoEb5)}`);

  // (n) D5 — dedup-fallback interaction is PINNED, not gated. With the
  // streaming Set unavailable (_dedupFallbackMode → base-class tail window)
  // and a window of ONE line, poll 2's deferred unbounded walk re-appends
  // the first-run rows that fall outside the window — bounded by the
  // first-run row count — and then persists real tips, so poll 3 walks 0:
  // the blast is exactly once. Gating it either way would be worse (see the
  // D3 persistence comment in pollOnce).
  const groupFb = join(TEST_ROOT, "t12n-group");
  const { repo: repoFb, total: totalFb } = twoLineageRepo(groupFb);
  const mkFb = () => new GitLogConnector({ repoRoots: [groupFb], walkDepth: 1, now, logMaxCommitsFirstRun: 3 });
  const cFb1 = mkFb();
  const rFb1 = await cFb1.pollOnce();
  check("T12.n1 poll 1: bounded first run appended=3 and deferred the frontier ([])",
    rFb1.appended === 3 && rFb1.errors === 0 && Array.isArray(readHeavy(cFb1).per_repo_ref_tips?.[repoFb])
      && readHeavy(cFb1).per_repo_ref_tips[repoFb].length === 0, JSON.stringify(rFb1));
  const cFb2 = mkFb();
  cFb2.dedupTailLines = 1;
  cFb2._buildDedupSet = function () { this._dedupSetBuilt = true; this._dedupFallbackMode = true; };
  const rFb2 = await cFb2.pollOnce();
  const remainderFb = totalFb - 1 - rFb1.appended; // 2 user commits not yet on disk
  check("T12.n2 poll 2 under the tail-window fallback walks every lineage and re-appends duplicates: remainder < appended <= remainder + first-run rows",
    cFb2._dedupFallbackMode === true && rFb2.walked === totalFb && rFb2.errors === 0
      && rFb2.appended > remainderFb && rFb2.appended <= remainderFb + rFb1.appended,
    `${JSON.stringify(rFb2)} remainder=${remainderFb} firstRun=${rFb1.appended}`);
  console.log(`  T12.n record: fallback-mode deferred walk appended ${rFb2.appended} (remainder ${remainderFb} + ${rFb2.appended - remainderFb} duplicate re-appends, window=1, first-run rows=${rFb1.appended})`);
  check("T12.n3 poll 2 persisted real tips (non-empty sorted unique 40-hex)",
    isTipList(readHeavy(cFb2).per_repo_ref_tips?.[repoFb]) && isSortedUnique(readHeavy(cFb2).per_repo_ref_tips[repoFb]),
    JSON.stringify(readHeavy(cFb2).per_repo_ref_tips?.[repoFb]));
  const cFb3 = mkFb();
  const rFb3 = await cFb3.pollOnce();
  check("T12.n4 poll 3 (normal instance) walked=0 appended=0 errors=0 without the Set — the blast was exactly once",
    rFb3.walked === 0 && rFb3.appended === 0 && rFb3.errors === 0 && cFb3._dedupSetBuilt === false
      && rowsFor(repoFb) === (totalFb - 1) + (rFb2.appended - remainderFb),
    `${JSON.stringify(rFb3)} _dedupSetBuilt=${cFb3._dedupSetBuilt} rows=${rowsFor(repoFb)}`);

  clearLedger("git-log");
}

// ===========================================================================
// T13 — D2: dedup gate pinned. Every --once poll used to rebuild the full-
// ledger source_msg_id Set (~250 ms over 156 MB, 6,028 builds for 6,065
// polls) because zero-commit repos never earned a cursor and fell into
// _repoHasPriorHistory. D1 closed that with per_repo_ref_tips ([] is a valid
// persisted state). This test is the ALARM for that gate, not the patch: a
// quiet poll over a seeded ledger + a tips-bearing real repo + a zero-commit
// repo must walk 0 and never build the Set; a poll with a new commit must
// still build it (dedup safety unchanged) and keep the seeded rows in it.
// ===========================================================================
console.log("\n--- T13: dedup Set is built only when there is something to append ---");
{
  clearLedger("git-log");
  const ledgerPath = join(STORAGE_DIR, "sources", "git-log.jsonl");
  // Seed shape mirrors T5: rows keyed on a fake repo hash. Trailing newline so
  // the real append below lands on its own line.
  const N = 3;
  const seedLines = [];
  for (let i = 0; i < N; i++) {
    seedLines.push(JSON.stringify({ source_msg_id: `git:aaaabbbbcccc:sha${i}`, raw_content: { subject: `seed ${i}` } }));
  }
  writeFileSync(ledgerPath, seedLines.join("\n") + "\n");

  const group = join(TEST_ROOT, "t13-group");
  mkdirSync(group, { recursive: true });
  const emptyDir = join(group, "repo-t13-empty");
  mkdirSync(emptyDir, { recursive: true });
  const gitIn = (dir, args, env) => {
    const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
    if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
    return res.stdout;
  };
  gitIn(emptyDir, ["init", "-q", "-b", "main"]);
  // One operator commit on top of the fixture's quarantined root sentinel.
  const author = { name: "Operator", email: "operator@example.com" };
  const realDir = buildSyntheticRepo(join(group, "repo-t13-real"), [
    { subject: "t13 first real commit", content: "t13-a\n" },
  ], author);
  const now = (() => { let tick = 0; return () => new Date(1717400000000 + (tick++) * 1000).toISOString(); })();
  const mk = () => new GitLogConnector({ repoRoots: [group], walkDepth: 1, now });
  const readHeavy = (c) => JSON.parse(readFileSync(c.heavyCursorPath, "utf8"));

  // (a) Instance A: the real repo's commit lands; both repos earn a tips entry.
  const A = mk();
  const rA = await A.pollOnce();
  check("T13.a1 poll A appended=1 errors=0", rA.appended === 1 && rA.errors === 0, JSON.stringify(rA));
  const heavyA = readHeavy(A);
  check("T13.a2 zero-commit repo persists per_repo_ref_tips[emptyDir] === []",
    Array.isArray(heavyA.per_repo_ref_tips?.[emptyDir]) && heavyA.per_repo_ref_tips[emptyDir].length === 0,
    JSON.stringify(heavyA.per_repo_ref_tips?.[emptyDir]));
  check("T13.a3 real repo persists a non-empty per_repo_ref_tips[realDir]",
    Array.isArray(heavyA.per_repo_ref_tips?.[realDir]) && heavyA.per_repo_ref_tips[realDir].length > 0,
    JSON.stringify(heavyA.per_repo_ref_tips?.[realDir]));

  // (b) Instance B (fresh process): nothing new anywhere → no walk, no build.
  const B = mk();
  const rB = await B.pollOnce();
  const sB = B.getDedupStats();
  check("T13.b quiet poll: appended=0 errors=0 walked=0 and built=false",
    rB.appended === 0 && rB.errors === 0 && rB.walked === 0 && sB.built === false,
    `${JSON.stringify(rB)} built=${sB.built}`);

  // (c) One new commit → instance C must append it, which still triggers the
  // lazy build through _isDuplicate; the seeded rows are part of the Set.
  writeFileSync(join(realDir, "t13-b.txt"), "t13-b\n");
  gitIn(realDir, ["add", "t13-b.txt"]);
  gitIn(realDir, ["commit", "-q", "-m", "t13 second real commit"], {
    GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_AUTHOR_DATE: "1717200500 +0000",
    GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email, GIT_COMMITTER_DATE: "1717200500 +0000",
  });
  const C = mk();
  const rC = await C.pollOnce();
  const sC = C.getDedupStats();
  check("T13.c new commit: appended=1, built=true, unique_set_size >= seeded + appended",
    rC.appended === 1 && sC.built === true && sC.unique_set_size >= N + 2,
    `${JSON.stringify(rC)} built=${sC.built} unique_set_size=${sC.unique_set_size}`);

  clearLedger("git-log");
}

// ===========================================================================
// T14 — D2: telemetry attribution. The connector used to recordDrop(PASS)
// for every commit it CLASSIFIED, before knowing whether the row would be
// appended, so a restart-recovery re-walk (cursor + tips missing → full
// --all --reflog listing, every commit deduped) produced ~1.9M phantom
// git-log rows/day in the Stage-0 sink (99.8% of all counted telemetry)
// against 0–1 appended rows per poll. PASS telemetry now counts APPENDED
// rows only. telemetry.js was imported after the env setup above, so its
// counters and sink resolve under TEST_ROOT.
// ===========================================================================
console.log("\n--- T14: connector PASS telemetry counts appended rows only ---");
{
  clearLedger("git-log");
  resetForTests();
  const botAuthor = { name: "dependabot[bot]", email: "dependabot[bot]@users.noreply.github.com" };
  const operator = { name: "Operator", email: "operator@example.com" };
  // Root sentinel by the operator (quarantined); ONE bot-authored commit on
  // top with a plain subject, so only git_log_bot_commit_downgrade fires.
  const botDir = buildSyntheticRepo(join(TEST_ROOT, "repo-t14-bot"), [
    { subject: "chore(deps): bump lodash from 4.17.20 to 4.17.21", content: "lodash 4.17.21\n", author: botAuthor },
  ], operator);
  const now = (() => { let tick = 0; return () => new Date(1717500000000 + (tick++) * 1000).toISOString(); })();
  const mk = () => new GitLogConnector({ repoRoots: [botDir], walkDepth: 0, now });
  const passEntries = () => snapshotCounters().filter((e) => e.source === "git-log" && e.decision === "PASS");

  // (a) First poll appends the bot row → exactly one PASS counter, count 1.
  const c1 = mk();
  const r1 = await c1.pollOnce();
  const pass1 = passEntries();
  let deepEqual = false;
  try {
    assert.deepEqual(pass1, [{ source: "git-log", decision: "PASS", reason: "git_log_bot_commit_downgrade", count: 1 }]);
    deepEqual = true;
  } catch {}
  check("T14.a first poll appended=1 and exactly one git-log/PASS/git_log_bot_commit_downgrade count=1",
    r1.appended === 1 && deepEqual, `${JSON.stringify(r1)} pass=${JSON.stringify(pass1)}`);

  // (b) Restart recovery: forget the repo's cursor AND tips so a fresh
  // instance must re-walk full history. Every listed commit is already on
  // disk (dedup hit) or re-quarantined; NO PASS counter may be recorded.
  resetForTests();
  const light = JSON.parse(readFileSync(c1.cursorPath, "utf8"));
  if (light.per_repo_cursors) delete light.per_repo_cursors[botDir];
  writeFileSync(c1.cursorPath, JSON.stringify(light, null, 2) + "\n");
  const heavy = JSON.parse(readFileSync(c1.heavyCursorPath, "utf8"));
  if (heavy.per_repo_ref_tips) delete heavy.per_repo_ref_tips[botDir];
  if (heavy.per_repo_cursors) delete heavy.per_repo_cursors[botDir];
  writeFileSync(c1.heavyCursorPath, JSON.stringify(heavy) + "\n");

  const c2 = mk();
  const r2 = await c2.pollOnce();
  const pass2 = passEntries();
  const s2 = c2.getDedupStats();
  check("T14.b restart-recovery re-walk: appended=0, walked>=1, zero git-log/PASS counters",
    r2.appended === 0 && Number.isInteger(r2.walked) && r2.walked >= 1 && pass2.length === 0,
    `${JSON.stringify(r2)} pass=${JSON.stringify(pass2)}`);
  check("T14.b2 the zero is explained by a dedup hit, not a missed commit",
    s2.hits >= 1, `hits=${s2.hits} built=${s2.built}`);

  resetForTests();
  clearLedger("git-log");
}

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log(`\nAll git-log-local-connector assertions passed.`);
