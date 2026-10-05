// remaining-stringcap-sites-2.test.mjs — s10-remaining-stringcap-sites-2.
//
// Three whole-file ledger reads that s1's RESOLVED-TARGET census found and no
// node owned. Each is reached by resolving a readFileSync call's first argument
// back to the file it actually opens — none of the three arguments is spelled
// "ledger"; all three are `path`.
//
//   SITE 1  mcp/lib/ingest/stage0/githubevents.js  _buildGitlogShaIndex()
//           -> storage/sources/git-log.jsonl          (HARD tier, un-allowlistable)
//   SITE 2  mcp/lib/ingest/stage0/githubevents.js  _buildGheventsActivityIndex()
//           -> storage/sources/github-events.jsonl    (HARD tier, un-allowlistable)
//   SITE 3  scripts/backfill-embeddings.mjs        readLedger()
//           -> ledgers/memory.jsonl                   (SCRIPTS tier)
//
// A fourth site the brief named — scripts/backfill-embeddings.mjs readSidecar()
// at :181 — is REFUTED, not fixed. T13 pins the refutation as an executable
// assertion instead of a code change. See its header comment.
//
// MEASURED THIS SESSION (2026-08-12) on this machine, read-only probes:
//   vendor/node/bin/node -e "console.log(require('buffer').constants.MAX_STRING_LENGTH)"
//     -> 536870888        (node v24.15.0)
//   statSync on the three resolved targets (ledgers are append-only and live —
//   these are floors, re-stat before quoting):
//     -> 3072964265  ledgers/memory.jsonl              (5.723x the cap — THROWS TODAY)
//     ->  124163682  storage/sources/git-log.jsonl     (0.231x — under cap today)
//     ->    5241383  storage/sources/github-events.jsonl (0.0098x — under cap today)
//
// HONESTY ABOUT THE CAP PREMISE. Only SITE 3 exceeds the cap today; its throw
// was reproduced directly (T10's stderr carries the readLedger -> runBackfill
// stack and a raw ERR_STRING_TOO_LONG on exit 1). SITE 1 and SITE 2 are under
// the cap and do not throw. Their horizons were MEASURED this session by summing
// each ledger's own rows per calendar day (day 0 of each is a connector backfill
// and skews any whole-span mean, so the trailing windows are what matter):
//     git-log.jsonl         446,966 / 1,899,066 / 1,037,139 B per day (7/14/30d)
//                           -> ~1-3 YEARS to 536,870,888 B
//     github-events.jsonl    74,444 /   146,368 /   109,874 B per day (7/14/30d)
//                           -> ~10-20 YEARS
// The brief's "SITE 2 grows ~12 KB/day, ~121-year horizon" was one poll's growth
// mistaken for a daily rate; the corrected figure is still a decade-plus, so the
// conclusion (SITE 2's cap premise is remote) survives even though the number
// did not. SITE 1's fuse, by contrast, is short enough to matter.
// What justifies SITE 2 regardless is the OTHER half of the defect, which is
// size-independent: a bare catch that converts UNREADABLE into EMPTY, so an
// EACCES/EIO/torn ledger is indistinguishable from "no rows". T7 is the test
// that matters for SITE 2; T5/T6 exist because the over-cap fixture is the
// cheapest way to prove the read is genuinely streamed.
//
// FIXTURE COST. A 600,000,000-byte hole plus head/tail rows is a 600,000,120 B
// APPARENT ledger costing 8,192 B of real disk (st.blocks * 512, measured):
// openSync + head write + ftruncateSync + tail write past the hole (FINDINGS
// F4). Every over-cap fixture is shape-asserted by assertOverCapShape() so a
// future maxLineBytes change cannot silently hollow one out.
//
// HERMETIC. Every fixture lives under mkdtempSync. STORAGE_BASE_DIR /
// LEDGERS_BASE_DIR / MEMORY_ROOT / QUARANTINE_BASE_DIR are set before the first
// dynamic import of config.js, and a hermeticity gate refuses to run if
// STORAGE_DIR did not land inside the temp root. SITE 3 runs in SPAWNED
// CHILDREN with their own temp roots. Nothing here reads or writes the live
// ledgers/, indices/, storage/ or connectors/*/state.json, and nothing signals
// a daemon.
//
// Ships UNREGISTERED — g1 owns mcp/scripts/run-all-tests.mjs.
// Run: cd <checkout>/mcp && node --test test/remaining-stringcap-sites-2.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { constants as bufferConstants } from "node:buffer";

import { streamLedgerLines } from "../lib/synthesis/_ledger-stream.js";

const MAX_STRING_LENGTH = bufferConstants.MAX_STRING_LENGTH;
const THIS_FILE = fileURLToPath(import.meta.url);
const MCP_DIR = dirname(dirname(THIS_FILE));
const REPO_ROOT = dirname(MCP_DIR);
const BACKFILL_SCRIPT = join(REPO_ROOT, "scripts", "backfill-embeddings.mjs");

// ---------------------------------------------------------------------------
// Sparse over-cap fixture builder (shape borrowed from
// mcp/test/scripts-stringcap.test.mjs makeOverCapLedger).
//
// The LEADING "\n" on the tail write is load-bearing: ftruncateSync leaves a
// 600 MB run of NUL bytes with no newline in it, so without that newline the
// head row, the NUL run and the tail rows are ONE over-long line, every
// streaming primitive abandons it at maxLineBytes, and the fixture proves
// nothing. assertOverCapShape() below is the interlock.
// ---------------------------------------------------------------------------
const APPARENT_BYTES = 600_000_000;

function makeOverCapLedger(dir, name, headRows, tailRows) {
  const p = join(dir, name);
  const fd = openSync(p, "w", 0o600);
  writeSync(fd, headRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  ftruncateSync(fd, APPARENT_BYTES);
  writeSync(
    fd,
    "\n" + tailRows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    APPARENT_BYTES,
  );
  closeSync(fd);
  return p;
}

function assertOverCapShape(p, expectedRows, label) {
  const size = statSync(p).size;
  assert.ok(
    size > MAX_STRING_LENGTH,
    `${label}: fixture is ${size} B, not over the ${MAX_STRING_LENGTH} B cap`,
  );
  const counts = streamLedgerLines(p, () => {});
  assert.equal(
    counts.totalLines,
    expectedRows,
    `${label}: expected ${expectedRows} real rows, got ${counts.totalLines} — fixture is hollow`,
  );
  assert.equal(
    counts.parsedLines,
    expectedRows,
    `${label}: expected ${expectedRows} parseable rows, got ${counts.parsedLines}`,
  );
  assert.ok(
    counts.skipped >= 1,
    `${label}: skipped=${counts.skipped}, expected >= 1 — the 600 MB NUL run was NOT seen, ` +
      "so head and tail are one joined line and this fixture proves nothing",
  );
  assert.equal(counts.readError, null, `${label}: unexpected readError ${counts.readError}`);
  return counts;
}

// ===========================================================================
// SITES 1 + 2 — hermetic env BEFORE the first import of config.js.
// ===========================================================================
const GH_ROOT = mkdtempSync(join(tmpdir(), "memsys-s10-gh-"));
const GH_STORAGE = join(GH_ROOT, "storage");
const GH_SOURCES = join(GH_STORAGE, "sources");
const GH_QUARANTINE = join(GH_ROOT, "quarantine");
const GH_LEDGERS = join(GH_ROOT, "ledgers");
const GH_POLICY = join(GH_ROOT, "policy");
for (const d of [GH_STORAGE, GH_SOURCES, GH_QUARANTINE, GH_LEDGERS, GH_POLICY]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}
process.env.MEMORY_ROOT = GH_ROOT;
process.env.STORAGE_BASE_DIR = GH_STORAGE;
process.env.LEDGERS_BASE_DIR = GH_LEDGERS;
process.env.POLICY_BASE_DIR = GH_POLICY;
// quarantine.js:206 honors QUARANTINE_BASE_DIR independently of STORAGE_DIR.
// Both are pinned so a DROP in these tests can never append to live storage/.
process.env.QUARANTINE_BASE_DIR = GH_QUARANTINE;

const configMod = await import("../lib/config.js");
assert.equal(
  configMod.STORAGE_DIR,
  GH_STORAGE,
  `config.STORAGE_DIR resolved to ${configMod.STORAGE_DIR}, not ${GH_STORAGE} — ` +
    "refusing to drive stage0 against a non-hermetic storage root",
);

const ghMod = await import("../lib/ingest/stage0/githubevents.js");
const {
  stage0: ghStage0,
  _resetGitlogShaCacheForTest,
  _resetGheventsActivityCacheForTest,
} = ghMod;

const GITLOG_LEDGER = join(GH_SOURCES, "git-log.jsonl");
const GHEVENTS_LEDGER = join(GH_SOURCES, "github-events.jsonl");

// git-log.jsonl row shape (only the fields _buildGitlogShaIndex reads plus
// enough padding to be representative).
function gitlogRow(sha, repoPath, pad = 0) {
  return {
    id: `gl_${sha.slice(0, 8)}`,
    ts: "2026-08-11T00:00:00.000Z",
    source: "git-log",
    raw_content: {
      commit_hash: sha,
      repo_path: repoPath,
      subject: `subject for ${sha.slice(0, 8)}`,
      body: pad > 0 ? "b".repeat(pad) : "",
    },
  };
}

// github-events.jsonl row shape for a PAIRING event (PushEvent).
function ghPushRow(repoSlug, ref, createdAtMs, pad = 0) {
  return {
    id: `ghe_${createdAtMs}_${ref}`,
    ts: new Date(createdAtMs).toISOString(),
    source: "github-events",
    raw_content: {
      event_type: "PushEvent",
      repo: repoSlug,
      ref,
      created_at: new Date(createdAtMs).toISOString(),
      head: "0".repeat(40),
      commits: 2,
      first_message: pad > 0 ? "m".repeat(pad) : "msg",
    },
  };
}

function sha40(seed) {
  const hex = "0123456789abcdef";
  let s = "";
  let x = seed >>> 0;
  for (let i = 0; i < 40; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    s += hex[(x >>> 16) & 0xf];
  }
  return s;
}

// Capture console.warn for the duration of fn(). The loud-degrade requirement
// is "an operator can SEE the read failure" — in a stage0 module that must
// never crash the dispatcher, stderr is the only channel that qualifies, and
// it is the channel the two in-tree precedents use
// (cross-source-dedup.js _warnOnce, stage0/telemetry.js NOVEL_REASON_WARNED).
function captureWarn(fn) {
  const lines = [];
  const orig = console.warn;
  // eslint-disable-next-line no-console
  console.warn = (...args) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    return { result: fn(), warnings: lines };
  } finally {
    // eslint-disable-next-line no-console
    console.warn = orig;
  }
}

// ---------------------------------------------------------------------------
// SITE 1 — T1: the git-log SHA index must see a row PAST the 536,870,888-byte
// boundary. Pre-fix, readFileSync throws ERR_STRING_TOO_LONG, the bare catch at
// _buildGitlogShaIndex swallows it, the index is EMPTY, and the F8 dedup rule
// silently no-ops: the duplicate PushEvent PASSes.
// ---------------------------------------------------------------------------
test("T1 SITE1 over-cap git-log: a tail commit_hash still dedups its PushEvent", () => {
  const TAIL_SHA = sha40(1001);
  const p = makeOverCapLedger(
    GH_SOURCES,
    "git-log.jsonl",
    [gitlogRow(sha40(1), "/Users/alex/memory-system")],
    [
      gitlogRow(sha40(2), "/Users/alex/memory-system"),
      gitlogRow(TAIL_SHA, "/Users/alex/memory-system"),
    ],
  );
  assertOverCapShape(p, 3, "T1");
  _resetGitlogShaCacheForTest();

  const r = ghStage0({
    source: "github-events",
    ts: "2026-08-11T12:00:00.000Z",
    raw_content: {
      event_type: "PushEvent",
      actor_login: "alex-example",
      repo: "example-org/memory-system",
      head: TAIL_SHA,
      commits: 3,
      first_message: "real work",
      ref: "refs/heads/main",
    },
  });

  assert.equal(
    r.decision,
    "DROP",
    "the tail SHA sits past the 536,870,888-byte cap; a whole-file read cannot see it " +
      `(got ${r.decision}/${r.reason})`,
  );
  assert.equal(r.reason, "duplicate_of_gitlog_commit");
});

// ---------------------------------------------------------------------------
// SITE 1 — T2: the HEAD row must work too. Pre-fix this also fails, because the
// throw kills the whole build, not just the tail. Post-fix it proves the stream
// starts at byte 0 and not at some offset.
// ---------------------------------------------------------------------------
test("T2 SITE1 over-cap git-log: a head commit_hash also dedups", () => {
  const HEAD_SHA = sha40(2001);
  const p = makeOverCapLedger(
    GH_SOURCES,
    "git-log.jsonl",
    [gitlogRow(HEAD_SHA, "/Users/alex/memory-system")],
    [gitlogRow(sha40(2002), "/Users/alex/memory-system")],
  );
  assertOverCapShape(p, 2, "T2");
  _resetGitlogShaCacheForTest();

  const r = ghStage0({
    source: "github-events",
    ts: "2026-08-11T12:00:00.000Z",
    raw_content: {
      event_type: "PushEvent",
      actor_login: "alex-example",
      repo: "example-org/memory-system",
      head: HEAD_SHA,
      commits: 3,
      first_message: "real work",
      ref: "refs/heads/main",
    },
  });
  assert.equal(r.decision, "DROP", `head SHA must dedup (got ${r.decision}/${r.reason})`);
  assert.equal(r.reason, "duplicate_of_gitlog_commit");
});

// ---------------------------------------------------------------------------
// SITE 1 — T3: VACUITY GUARD. An unknown SHA must still PASS. Without this, a
// fix that returned "everything is a duplicate" would look green on T1/T2.
// ---------------------------------------------------------------------------
test("T3 SITE1 vacuity guard: an unknown SHA is not dropped", () => {
  const p = makeOverCapLedger(
    GH_SOURCES,
    "git-log.jsonl",
    [gitlogRow(sha40(3001), "/Users/alex/memory-system")],
    [gitlogRow(sha40(3002), "/Users/alex/memory-system")],
  );
  assertOverCapShape(p, 2, "T3");
  _resetGitlogShaCacheForTest();

  const r = ghStage0({
    source: "github-events",
    ts: "2026-08-11T12:00:00.000Z",
    raw_content: {
      event_type: "PushEvent",
      actor_login: "alex-example",
      repo: "example-org/memory-system",
      head: sha40(999999),
      commits: 3,
      first_message: "real work",
      ref: "refs/heads/main",
    },
  });
  assert.equal(r.decision, "PASS", `unknown SHA must PASS (got ${r.decision}/${r.reason})`);
});

// ---------------------------------------------------------------------------
// SITE 1 — T4: THE BARE CATCH IS HALF THE DEFECT. An UNREADABLE git-log ledger
// must not present as an EMPTY one. The dispatcher must still not crash (that
// invariant is preserved byte-exactly: decision stays PASS), but the failure
// has to reach an operator. Pre-fix: total silence.
// ---------------------------------------------------------------------------
test("T4 SITE1 unreadable git-log is LOUD, not silently empty", () => {
  const p = join(GH_SOURCES, "git-log.jsonl");
  writeFileSync(p, JSON.stringify(gitlogRow(sha40(4001), "/Users/alex/x")) + "\n", {
    mode: 0o600,
  });
  chmodSync(p, 0o000);
  _resetGitlogShaCacheForTest();
  try {
    const { result, warnings } = captureWarn(() =>
      ghStage0({
        source: "github-events",
        ts: "2026-08-11T12:00:00.000Z",
        raw_content: {
          event_type: "PushEvent",
          actor_login: "alex-example",
          repo: "example-org/memory-system",
          head: sha40(4001),
          commits: 3,
          first_message: "real work",
          ref: "refs/heads/main",
        },
      }),
    );
    // PRESERVED BYTE-EXACTLY: stage0 never crashes the dispatcher, and an
    // unreadable git-log still means "cannot prove duplicate" => PASS.
    assert.equal(result.decision, "PASS", "stage0 must never crash or drop on a read failure");
    assert.ok(
      warnings.length >= 1,
      "an unreadable git-log ledger produced ZERO operator-visible output — " +
        "this is the bare-catch defect: UNREADABLE presenting as EMPTY",
    );
    const joined = warnings.join("\n");
    assert.match(joined, /git-log/, `warning must name the ledger; got: ${joined}`);
    assert.match(
      joined,
      /EACCES|permission denied/i,
      `warning must carry the underlying fs cause; got: ${joined}`,
    );
  } finally {
    chmodSync(p, 0o600);
  }
});

// ---------------------------------------------------------------------------
// SITE 2 — T5: the github-events activity index must see a PAIRING PushEvent
// past the cap. Pre-fix the index is empty, so a branch CreateEvent with a real
// paired push is quarantine-DROPPED as an orphan.
// ---------------------------------------------------------------------------
const NOW_MS = Date.now();

test("T5 SITE2 over-cap github-events: a tail PushEvent pairs a branch CreateEvent", () => {
  const p = makeOverCapLedger(
    GH_SOURCES,
    "github-events.jsonl",
    [ghPushRow("example-org/memory-system", "refs/heads/other-branch", NOW_MS - 3600_000)],
    [
      ghPushRow("example-org/other-repo", "refs/heads/feature/s10", NOW_MS - 7200_000),
      ghPushRow("example-org/memory-system", "refs/heads/feature/s10", NOW_MS - 3600_000),
    ],
  );
  assertOverCapShape(p, 3, "T5");
  _resetGheventsActivityCacheForTest();

  const r = ghStage0({
    source: "github-events",
    ts: new Date(NOW_MS).toISOString(),
    raw_content: {
      event_type: "CreateEvent",
      ref_type: "branch",
      actor_login: "alex-example",
      repo: "example-org/memory-system",
      ref: "feature/s10",
      created_at: new Date(NOW_MS).toISOString(),
    },
  });

  assert.equal(
    r.decision,
    "PASS",
    "the pairing PushEvent sits past the 536,870,888-byte cap; a whole-file read cannot " +
      `see it, so the CreateEvent is orphan-dropped (got ${r.decision}/${r.reason})`,
  );
  assert.equal(r.reason, "gh_branch_lifecycle_paired_downgrade");
  assert.equal(r.structural_score, 0.30);
});

// ---------------------------------------------------------------------------
// SITE 2 — T6: VACUITY GUARD. A branch with NO paired activity must still be
// orphan-dropped, with the reason that says we PROVED it.
// ---------------------------------------------------------------------------
test("T6 SITE2 vacuity guard: a genuinely unpaired branch still orphan-drops", () => {
  const p = makeOverCapLedger(
    GH_SOURCES,
    "github-events.jsonl",
    [ghPushRow("example-org/memory-system", "refs/heads/unrelated-a", NOW_MS - 3600_000)],
    [ghPushRow("example-org/memory-system", "refs/heads/unrelated-b", NOW_MS - 3600_000)],
  );
  assertOverCapShape(p, 2, "T6");
  _resetGheventsActivityCacheForTest();

  const r = ghStage0({
    source: "github-events",
    ts: new Date(NOW_MS).toISOString(),
    raw_content: {
      event_type: "CreateEvent",
      ref_type: "branch",
      actor_login: "alex-example",
      repo: "example-org/memory-system",
      ref: "feature/no-pair",
      created_at: new Date(NOW_MS).toISOString(),
    },
  });
  assert.equal(r.decision, "DROP", `unpaired branch must drop (got ${r.decision}/${r.reason})`);
  assert.equal(
    r.reason,
    "gh_branch_lifecycle_orphan_drop",
    "a PROVEN orphan keeps the orphan reason",
  );
});

// ---------------------------------------------------------------------------
// SITE 2 — T7: THE REASON MUST STOP LYING. The module already distinguishes
// "we proved no pairing" (gh_branch_lifecycle_orphan_drop) from "we could not
// run the window check" (branch_lifecycle, the F4 legacy fallback) — see the
// dropReason/ruleId ternaries in the CreateEvent branch. An UNREADABLE
// github-events ledger is exactly the second case, and today it is reported as
// the first. The DROP DECISION IS UNCHANGED in both directions; only the reason
// and the operator-visible warning change.
// ---------------------------------------------------------------------------
test("T7 SITE2 unreadable github-events downgrades the reason and is LOUD", () => {
  const p = join(GH_SOURCES, "github-events.jsonl");
  writeFileSync(
    p,
    JSON.stringify(ghPushRow("example-org/memory-system", "refs/heads/feature/s10b", NOW_MS)) + "\n",
    { mode: 0o600 },
  );
  chmodSync(p, 0o000);
  _resetGheventsActivityCacheForTest();
  try {
    const { result, warnings } = captureWarn(() =>
      ghStage0({
        source: "github-events",
        ts: new Date(NOW_MS).toISOString(),
        raw_content: {
          event_type: "CreateEvent",
          ref_type: "branch",
          actor_login: "alex-example",
          repo: "example-org/memory-system",
          ref: "feature/s10b",
          created_at: new Date(NOW_MS).toISOString(),
        },
      }),
    );
    // PRESERVED BYTE-EXACTLY: still a DROP, still quarantined, still no crash.
    assert.equal(result.decision, "DROP", "the drop decision must not change");
    assert.equal(
      result.reason,
      "branch_lifecycle",
      "an UNREADABLE activity ledger means the window check could not run — claiming " +
        "gh_branch_lifecycle_orphan_drop asserts a proof the code does not have",
    );
    assert.ok(
      warnings.length >= 1,
      "an unreadable github-events ledger produced ZERO operator-visible output",
    );
    const joined = warnings.join("\n");
    assert.match(joined, /github-events/, `warning must name the ledger; got: ${joined}`);
    assert.match(
      joined,
      /EACCES|permission denied/i,
      `warning must carry the underlying fs cause; got: ${joined}`,
    );
  } finally {
    chmodSync(p, 0o600);
  }
});

// ---------------------------------------------------------------------------
// SITE 1 — T8: BOUNDED RETENTION *AND* BOUNDED PEAK, MEASURED IN A CHILD.
//
// F7 and F16 are both "the remedy was worse than the defect" heap OOMs shipped
// by a naive swap, so this measures two DIFFERENT things and asserts both:
//
//   retained — heapUsed delta across the operation with global.gc() forced on
//              both sides. This is what the module still HOLDS afterwards (the
//              5-minute-TTL index cache). It is the F7 guard on the remedy: a
//              streaming swap that accumulated rows would show up here and
//              nowhere else. Note it is NOT a pre/post discriminator — the
//              whole-file string is garbage by the time the second gc() runs,
//              so the OLD code scores well on this axis too. Both directions
//              are recorded in the node report rather than implied here.
//   peakGrowth — process.resourceUsage().maxRSS delta across the operation.
//              maxRSS is monotone (it is a peak), and on this platform it is
//              reported in KILOBYTES: verified in-session by allocating and
//              filling a 200 MiB Buffer and observing a 205,328-unit delta
//              (200.5 MiB if the unit is kB; 0.2 MiB if it were bytes). THIS is
//              the axis the whole-file read loses on, because the 40 MB string
//              and its split array are alive simultaneously.
//
// MEASURED 2026-08-12 on the fixture below (39,840,000 B, 30,000 rows). Pre-fix
// figures come from running this same suite against `git show HEAD:` copies of
// both source files, materialized OUTSIDE the repo with their relative import
// specifiers absolutized — the working tree was never reverted. Three runs each:
//   pre-fix  (readFileSync + split):  retained ~5,923,000 B = 0.149 B/B
//                                     peak +171,120/171,600/171,568 kB
//                                                            = 4.398-4.411 B/B
//   post-fix (streamLedgerLines):     retained ~5,946,700 B = 0.149 B/B
//                                     peak  +26,224/26,544/26,256/26,640 kB
//                                                            = 0.674-0.685 B/B
// (four post-fix runs; these are OBSERVED spreads, not bounds — the asserted
// budget is T8_PEAK_BUDGET below, which both spreads sit far apart across.)
// The retained figure is IDENTICAL either way — both shapes keep exactly the
// two Sets — which is why the retained budget is a guard on the remedy and the
// PEAK budget is the one that separates the two implementations.
// ---------------------------------------------------------------------------
const T8_RETAINED_BUDGET = 0.35;
const T8_PEAK_BUDGET = 1.0;

test("T8 SITE1 bounded retention + bounded peak on a ~40 MB git-log", () => {
  const N = 30_000;
  const p = join(GH_SOURCES, "git-log.jsonl");
  {
    const fd = openSync(p, "w", 0o600);
    let buf = "";
    for (let i = 0; i < N; i++) {
      buf += JSON.stringify(gitlogRow(sha40(500_000 + i), "/Users/alex/memory-system", 1100)) + "\n";
      if (buf.length > 1 << 20) {
        writeSync(fd, buf);
        buf = "";
      }
    }
    if (buf.length > 0) writeSync(fd, buf);
    closeSync(fd);
  }
  const bytes = statSync(p).size;
  assert.ok(bytes > 30_000_000, `retention fixture is only ${bytes} B — too small to bound`);

  // The measurement runs in a child so global.gc() is available regardless of
  // how the suite itself was launched (the node gate is a bare `node --test`).
  const event = {
    source: "github-events",
    ts: "2026-08-11T12:00:00.000Z",
    raw_content: {
      event_type: "PushEvent",
      actor_login: "alex-example",
      repo: "example-org/memory-system",
      head: sha40(500_000 + N - 1), // LAST row -> the scan runs end-to-end
      commits: 3,
      first_message: "real work",
      ref: "refs/heads/main",
    },
  };
  const driver = join(GH_ROOT, "t8-driver.mjs");
  writeFileSync(
    driver,
    `import { STORAGE_DIR } from ${JSON.stringify(join(MCP_DIR, "lib", "config.js"))};\n` +
      `const GH_STORAGE = ${JSON.stringify(GH_STORAGE)};\n` +
      `if (STORAGE_DIR !== GH_STORAGE) {\n` +
      `  console.error("HERMETICITY ABORT: " + STORAGE_DIR);\n` +
      `  process.exit(9);\n` +
      `}\n` +
      `const gh = await import(${JSON.stringify(
        join(MCP_DIR, "lib", "ingest", "stage0", "githubevents.js"),
      )});\n` +
      `gh._resetGitlogShaCacheForTest();\n` +
      `global.gc(); global.gc();\n` +
      `const heap0 = process.memoryUsage().heapUsed;\n` +
      `const peak0 = process.resourceUsage().maxRSS;\n` +
      `const r = gh.stage0(${JSON.stringify(event)});\n` +
      `const peak1 = process.resourceUsage().maxRSS;\n` +
      `global.gc(); global.gc();\n` +
      `const heap1 = process.memoryUsage().heapUsed;\n` +
      `console.log(JSON.stringify({ decision: r.decision, reason: r.reason,\n` +
      `  retained: heap1 - heap0, peakKb: peak1 - peak0 }));\n`,
    { mode: 0o600 },
  );
  const res = spawnSync(process.execPath, ["--expose-gc", driver], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(res.status, 0, `T8 driver failed: ${(res.stderr || "").slice(0, 800)}`);
  const out = JSON.parse((res.stdout || "").trim().split("\n").pop());

  assert.equal(
    out.decision,
    "DROP",
    "the LAST row must be indexed for this to be an end-to-end bound",
  );
  const retainedRatio = out.retained / bytes;
  const peakRatio = (out.peakKb * 1024) / bytes;
  process.stdout.write(
    `  T8 measured: fixture ${bytes} B, retained ${out.retained} B ` +
      `(${retainedRatio.toFixed(3)} B/B), peak +${out.peakKb} kB ` +
      `(${peakRatio.toFixed(3)} B/B)\n`,
  );
  assert.ok(
    retainedRatio < T8_RETAINED_BUDGET,
    `bounded retention violated: the index retained ${out.retained} B after a ${bytes} B ` +
      `scan (${retainedRatio.toFixed(3)} heap bytes per file byte; budget ${T8_RETAINED_BUDGET}).`,
  );
  assert.ok(
    peakRatio < T8_PEAK_BUDGET,
    `bounded PEAK violated: maxRSS grew ${out.peakKb} kB across a ${bytes} B fixture ` +
      `(${peakRatio.toFixed(3)} peak bytes per file byte; budget ${T8_PEAK_BUDGET}). ` +
      "A whole-file read holds the string and its split array at once.",
  );
});

// ===========================================================================
// SITE 3 — scripts/backfill-embeddings.mjs readLedger(), spawned children.
//
// The script imports gemini-client (key-shape check at boot) and the recall
// index-cache/HNSW addon at module scope, so every SITE 3 case runs in its own
// child process with its own temp root, its own env overrides, and a
// hermeticity gate that aborts unless memoryLedgerPath() lands inside the temp
// root.
// ===========================================================================
function makeSite3Root(tag) {
  const root = mkdtempSync(join(tmpdir(), `memsys-s10-s3-${tag}-`));
  for (const d of ["storage", "ledgers", "policy", "indices"]) {
    mkdirSync(join(root, d), { recursive: true, mode: 0o700 });
  }
  return root;
}

function site3Env(root) {
  return {
    ...process.env,
    MEMORY_ROOT: root,
    STORAGE_BASE_DIR: join(root, "storage"),
    LEDGERS_BASE_DIR: join(root, "ledgers"),
    POLICY_BASE_DIR: join(root, "policy"),
    QUARANTINE_BASE_DIR: join(root, "quarantine"),
    GEMINI_API_KEY:
      process.env.GEMINI_API_KEY || "AIzaJUNK_test_not_used_xxxxxxxxxxxxxxxxx",
  };
}

// Writes a driver .mjs into the temp root and runs it. The driver re-asserts
// hermeticity from inside the child before importing the script under test.
function runSite3Driver(root, body, execArgv = []) {
  const driver = join(root, "driver.mjs");
  writeFileSync(
    driver,
    `import { memoryLedgerPath } from ${JSON.stringify(join(MCP_DIR, "lib", "config.js"))};\n` +
      `const ROOT = ${JSON.stringify(root)};\n` +
      `if (!memoryLedgerPath().startsWith(ROOT)) {\n` +
      `  console.error("HERMETICITY ABORT: " + memoryLedgerPath());\n` +
      `  process.exit(9);\n` +
      `}\n` +
      `const mod = await import(${JSON.stringify(BACKFILL_SCRIPT)});\n` +
      body,
    { mode: 0o600 },
  );
  const res = spawnSync(process.execPath, [...execArgv, driver], {
    encoding: "utf8",
    env: site3Env(root),
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
}

function memRow(id, kind = "fact") {
  return {
    id,
    kind,
    content: `content for ${id}`,
    created_at: "2026-08-01T00:00:00.000Z",
    features: {},
  };
}

// ---------------------------------------------------------------------------
// SITE 3 — T9: runBackfill against an OVER-CAP ledger must REFUSE with a named
// cause, not blow up with an opaque V8 string-cap error.
//
// WHY REFUSAL AND NOT REPAIR. Verified this session:
//   * MODEL_VERSION pins to CAPS.GEMINI_EMBEDDING_MODEL_DEFAULT, which resolves
//     at runtime to "gemini-embedding-001".
//   * The live index manifest is indices/qwen3-embedding-8b-fp16/
//     index-manifest.json: generation 87, embedding_model_version
//     qwen3-embedding-8b-fp16, dims 4096, created 2026-08-12T00:43:35.800Z.
//   * `crontab -l` -> "no crontab for <user>"; `launchctl list | grep backfill`
//     -> nothing. No shell or plist invokes the script.
//   * The live re-embed path is daemons/reembed-drain.mjs:382 spawning
//     mcp/scripts/reembed-local-4096.mjs, which already streams
//     (createReadStream at :115 and :132) and names MAX_STRING_LENGTH at :109.
// So the cap throw is currently the ONLY interlock stopping a superseded
// publisher from walking 1.5M facts and publishing a generation for the pinned
// model version. Streaming it would REMOVE that interlock — the F7/F16 shape
// (remedy worse than defect) in a new costume. In-tree precedent for the
// alternative: mcp/test/scripts-stringcap.test.mjs T4 made
// backfill-seed-row-marker.mjs REFUSE with exit 4 rather than repairing it.
// ---------------------------------------------------------------------------
test("T9 SITE3 over-cap ledger: runBackfill REFUSES with a named cause", () => {
  const root = makeSite3Root("refuse");
  const p = makeOverCapLedger(
    join(root, "ledgers"),
    "memory.jsonl",
    [memRow("mem_head")],
    [memRow("mem_tail")],
  );
  assertOverCapShape(p, 2, "T9");

  const { code, stdout, stderr } = runSite3Driver(
    root,
    `try {\n` +
      `  await mod.runBackfill({ dryRun: true, logger: { log(){}, warn(){} } });\n` +
      `  console.log(JSON.stringify({ threw: false }));\n` +
      `} catch (e) {\n` +
      `  console.log(JSON.stringify({ threw: true, code: e && e.code, message: String(e && e.message) }));\n` +
      `}\n`,
  );
  assert.equal(code, 0, `driver failed to run: ${stderr}`);
  const out = JSON.parse(stdout.trim().split("\n").pop());
  assert.equal(out.threw, true, "an over-cap ledger must not silently succeed");
  assert.equal(
    out.code,
    "LEDGER_OVER_STRING_CAP",
    `refusal must be a typed, named cause — got code=${out.code} message=${out.message}`,
  );
  assert.match(out.message, /string cap|MAX_STRING_LENGTH/i, "message must name the cap");
  assert.match(out.message, /gemini-embedding-001/, "message must name the pinned model version");
  assert.match(
    out.message,
    /reembed-local-4096\.mjs/,
    "message must point at the supported re-embed path",
  );
  assert.doesNotMatch(
    out.message,
    /ERR_STRING_TOO_LONG|Cannot create a string longer/,
    "the refusal must replace the opaque V8 error, not wrap it",
  );
});

// ---------------------------------------------------------------------------
// SITE 3 — T10: the CLI surfaces the refusal as a DISTINCT exit code (4),
// matching the in-tree refusal convention (scripts-stringcap.test.mjs T4).
// Pre-fix the CLI exits 1 with a raw ERR_STRING_TOO_LONG stack.
// ---------------------------------------------------------------------------
test("T10 SITE3 CLI exits 4 on the refusal, with the cause on stderr", () => {
  const root = makeSite3Root("cli");
  const p = makeOverCapLedger(
    join(root, "ledgers"),
    "memory.jsonl",
    [memRow("mem_head")],
    [memRow("mem_tail")],
  );
  assertOverCapShape(p, 2, "T10");
  const before = statSync(p);

  const res = spawnSync(process.execPath, [BACKFILL_SCRIPT, "--dry-run"], {
    encoding: "utf8",
    env: site3Env(root),
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(
    res.status,
    4,
    `refusal must exit 4 (got ${res.status}); stderr=${(res.stderr || "").slice(0, 600)}`,
  );
  assert.match(res.stderr, /REFUS/i, "stderr must say it refused");
  assert.match(res.stderr, /string cap|MAX_STRING_LENGTH/i, "stderr must name the cap");
  assert.match(res.stderr, /reembed-local-4096\.mjs/, "stderr must name the supported path");
  assert.doesNotMatch(res.stderr, /ERR_STRING_TOO_LONG/, "no opaque V8 error on the refusal path");

  const after = statSync(p);
  assert.equal(after.size, before.size, "the refusal must not have rewritten the ledger");
});

// ---------------------------------------------------------------------------
// SITE 3 — T11: PRESERVATION PIN. The under-cap path must be byte-identical:
// same summary fields, same log lines, same ordering. This test passes BEFORE
// and AFTER; it exists so the refusal gate cannot be bought with a behaviour
// change on the working path.
// ---------------------------------------------------------------------------
test("T11 SITE3 under-cap dry-run is preserved byte-exactly", () => {
  const root = makeSite3Root("preserve");
  const rows = [
    memRow("mem_a"),
    memRow("mem_b"),
    { ...memRow("mem_c"), features: { embedding_3072: new Array(3072).fill(0) } },
    memRow("mem_pol", "policy"),
    { id: "mem_noid_kind", kind: "fact", content: "x", created_at: "2026-08-01T00:00:00.000Z" },
    { kind: "fact", content: "no id at all", created_at: "2026-08-01T00:00:00.000Z" },
  ];
  writeFileSync(
    join(root, "ledgers", "memory.jsonl"),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n" + "{not json\n",
    { mode: 0o600 },
  );

  const { code, stdout, stderr } = runSite3Driver(
    root,
    `const logs = [];\n` +
      `const summary = await mod.runBackfill({ dryRun: true, logger: { log: (m) => logs.push(String(m)), warn: () => {} } });\n` +
      `console.log(JSON.stringify({ summary, logs }));\n`,
  );
  assert.equal(code, 0, `driver failed: ${stderr}`);
  const out = JSON.parse(stdout.trim().split("\n").pop());

  // ledger_rows counts rows with a string id (the pre-fix readLedger filter);
  // the id-less row and the torn line are excluded. fact_rows counts kind:fact
  // among those. to_embed excludes mem_c (inline embedding_3072).
  assert.equal(out.summary.ledger_rows, 5, "ledger_rows must count rows with a string id");
  assert.equal(out.summary.fact_rows, 4, "fact_rows must count kind:fact among those");
  assert.equal(out.summary.to_embed, 3, "mem_c carries an inline 3072d embedding");
  assert.equal(out.summary.sidecar_rows_before, 0);
  assert.equal(out.summary.dry_run, true);
  assert.equal(out.summary.bm25_size, 0);
  assert.equal(out.summary.hnsw_size, 0);
  assert.equal(out.summary.model_version, "gemini-embedding-001");

  // Log lines, in order, verbatim in shape.
  assert.equal(out.logs[0], "backfill: model_version=gemini-embedding-001");
  assert.equal(out.logs[1], `backfill: ledger=${join(root, "ledgers", "memory.jsonl")}`);
  assert.equal(out.logs[2], `backfill: indices_dir=${join(root, "indices", "gemini-embedding-001")}`);
  assert.equal(out.logs[3], "backfill: DRY-RUN mode (no writes, no embed calls)");
  assert.equal(out.logs[4], "backfill: ledger_rows=5 fact_rows=4 sidecar_rows=0");
  assert.equal(out.logs[5], "backfill: facts_to_embed=3");
  assert.equal(out.logs[6], "backfill: WOULD embed memory_id=mem_a content_len=17");
  assert.equal(out.logs[7], "backfill: WOULD embed memory_id=mem_b content_len=17");
  assert.equal(out.logs[8], "backfill: WOULD embed memory_id=mem_noid_kind content_len=1");
});

// ---------------------------------------------------------------------------
// SITE 3 — T12: read failure on an UNDER-CAP ledger must stay fail-closed.
// readFileSync threw on EACCES today and the caller had no catch, so the
// script aborted. streamLedgerLines never throws — it reports readError — so
// without an explicit check a permission failure would become "ledger_rows=0",
// i.e. "nothing to embed", i.e. a silent no-op publish. That is the exact
// UNREADABLE-becomes-EMPTY conflation this node exists to close.
// ---------------------------------------------------------------------------
test("T12 SITE3 unreadable under-cap ledger stays fail-closed", () => {
  const root = makeSite3Root("eacces");
  const p = join(root, "ledgers", "memory.jsonl");
  writeFileSync(p, JSON.stringify(memRow("mem_a")) + "\n", { mode: 0o600 });
  chmodSync(p, 0o000);
  try {
    const { code, stdout, stderr } = runSite3Driver(
      root,
      `try {\n` +
        `  const s = await mod.runBackfill({ dryRun: true, logger: { log(){}, warn(){} } });\n` +
        `  console.log(JSON.stringify({ threw: false, ledger_rows: s.ledger_rows }));\n` +
        `} catch (e) {\n` +
        `  console.log(JSON.stringify({ threw: true, code: e && e.code, message: String(e && e.message) }));\n` +
        `}\n`,
    );
    assert.equal(code, 0, `driver failed: ${stderr}`);
    const out = JSON.parse(stdout.trim().split("\n").pop());
    assert.equal(
      out.threw,
      true,
      `an unreadable ledger must not present as an empty one (got ledger_rows=${out.ledger_rows})`,
    );
    assert.match(
      String(out.message),
      /EACCES|permission denied/i,
      `the failure must name its cause; got ${out.message}`,
    );
  } finally {
    chmodSync(p, 0o600);
  }
});

// ---------------------------------------------------------------------------
// SITE 3 — T13: BOUNDED RETENTION AND BOUNDED PEAK, MEASURED. Same two axes as
// T8, same --expose-gc child discipline, same maxRSS-is-kilobytes calibration.
//
// The pre-fix readLedger retained EVERY row carrying a string id — including
// the non-fact half, which the caller only ever used to compute
// `allRows.length` — on top of the whole-file string and its split array. The
// streamed version retains ONLY the fact rows (steps 3-4 need one object per
// embed candidate and per BM25/HNSW posting, so this is the floor for what the
// script does) plus an integer.
//
// MEASURED 2026-08-12 on the 39,217,780 B / 30,000-row half-fact fixture below,
// three runs each; pre-fix figures taken against a `git show HEAD:` copy of the
// script materialized outside the repo (the working tree was never reverted):
//   pre-fix:  retained 54,784 B = 0.001 B/B
//             peak +209,552/209,440/209,568 kB = 5.469-5.472 B/B
//   post-fix: retained 77,624 B = 0.002 B/B
//             peak  +54,960/53,984/54,528 kB  = 1.410-1.435 B/B
// Retention after the call returns is near zero either way (the row arrays are
// runBackfill locals and die with it), so — as in T8 — the retained budget is
// the F7 guard on the remedy and the PEAK budget is the discriminator. The
// post-fix floor is the fact half of the corpus, which steps 3-4 genuinely need
// in memory.
// ---------------------------------------------------------------------------
const T13_RETAINED_BUDGET = 0.10;
const T13_PEAK_BUDGET = 2.5;

test("T13 SITE3 bounded retention + bounded peak on a ~40 MB ledger", () => {
  const root = makeSite3Root("retention");
  const p = join(root, "ledgers", "memory.jsonl");
  const N = 30_000;
  {
    const fd = openSync(p, "w", 0o600);
    let buf = "";
    for (let i = 0; i < N; i++) {
      // Half the corpus is NON-fact: retained by the pre-fix readLedger purely
      // so that `allRows.length` could be computed, never otherwise read.
      const kind = i % 2 === 0 ? "fact" : "recall";
      const row = {
        id: `mem_${i}`,
        kind,
        content: `c${i} ` + "x".repeat(1200),
        created_at: "2026-08-01T00:00:00.000Z",
        features: {},
      };
      buf += JSON.stringify(row) + "\n";
      if (buf.length > 1 << 20) {
        writeSync(fd, buf);
        buf = "";
      }
    }
    if (buf.length > 0) writeSync(fd, buf);
    closeSync(fd);
  }
  const bytes = statSync(p).size;
  assert.ok(bytes > 30_000_000, `retention fixture is only ${bytes} B`);
  assert.ok(bytes < MAX_STRING_LENGTH, "retention fixture must stay UNDER the cap");

  const { code, stdout, stderr } = runSite3Driver(
    root,
    `global.gc(); global.gc();\n` +
      `const heap0 = process.memoryUsage().heapUsed;\n` +
      `const peak0 = process.resourceUsage().maxRSS;\n` +
      `const s = await mod.runBackfill({ dryRun: true, logger: { log(){}, warn(){} } });\n` +
      `const peak1 = process.resourceUsage().maxRSS;\n` +
      `global.gc(); global.gc();\n` +
      `const heap1 = process.memoryUsage().heapUsed;\n` +
      `console.log(JSON.stringify({ retained: heap1 - heap0, peakKb: peak1 - peak0,\n` +
      `  ledger_rows: s.ledger_rows, fact_rows: s.fact_rows }));\n`,
    ["--expose-gc"],
  );
  assert.equal(code, 0, `driver failed: ${stderr}`);
  const out = JSON.parse(stdout.trim().split("\n").pop());
  assert.equal(out.ledger_rows, N, "every row carries a string id");
  assert.equal(out.fact_rows, N / 2, "half the corpus is kind:fact");
  const retainedRatio = out.retained / bytes;
  const peakRatio = (out.peakKb * 1024) / bytes;
  process.stdout.write(
    `  T13 measured: fixture ${bytes} B, retained ${out.retained} B ` +
      `(${retainedRatio.toFixed(3)} B/B), peak +${out.peakKb} kB ` +
      `(${peakRatio.toFixed(3)} B/B)\n`,
  );
  assert.ok(
    retainedRatio < T13_RETAINED_BUDGET,
    `bounded retention violated: ${out.retained} B retained across a ${bytes} B fixture ` +
      `(${retainedRatio.toFixed(3)} heap bytes per file byte; budget ${T13_RETAINED_BUDGET}). ` +
      "Retaining the non-fact half is the pre-fix shape.",
  );
  assert.ok(
    peakRatio < T13_PEAK_BUDGET,
    `bounded PEAK violated: maxRSS grew ${out.peakKb} kB across a ${bytes} B fixture ` +
      `(${peakRatio.toFixed(3)} peak bytes per file byte; budget ${T13_PEAK_BUDGET}).`,
  );
});

// ---------------------------------------------------------------------------
// SITE 4 — T14: THE REFUTATION, AS AN EXECUTABLE ASSERTION.
//
// The brief listed a fourth site, readSidecar() at
// scripts/backfill-embeddings.mjs:181, with a resolved target of
// indices/qwen3-embedding-8b-fp16/embeddings-sidecar.jsonl = 129,423,401 B.
// That attribution is wrong, and it is wrong in F32's exact grammar: a target
// assigned by PATTERN (a wildcard <model> path segment) rather than by the
// value the code computes.
//
// arg0 is sidecarPathFor(MODEL_VERSION) -> join(indicesDirFor(m),
// "embeddings-sidecar.jsonl") -> join(MEMORY_ROOT, "indices", m, ...), and the
// model segment is NOT free: MODEL_VERSION is pinned to
// CAPS.GEMINI_EMBEDDING_MODEL_DEFAULT. Verified this session:
//   * that CAP resolves to "gemini-embedding-001";
//   * `ls -la indices/gemini-embedding-001/` lists bm25.gen-2.json, bm25.json,
//     hnsw.bin, hnsw.gen-2.bin, index-digest-cache.json, index-manifest.json —
//     and NO embeddings-sidecar.jsonl, so the existsSync guard at :180 returns
//     before :181 ever runs;
//   * the 129 MB file belongs to indices/qwen3-embedding-8b-fp16/, which this
//     line cannot address and which mcp/scripts/reembed-local-4096.mjs already
//     reads with createReadStream.
// So :181 is NOT in this class and is NOT touched. This test pins the one fact
// that decides it — the model segment the code actually computes — without
// reading anything outside the temp root.
// ---------------------------------------------------------------------------
test("T14 SITE4 refuted: readSidecar's model segment is gemini-embedding-001, not qwen3", async () => {
  const validation = await import("../lib/validation.js");
  const pinned = validation.CAPS.GEMINI_EMBEDDING_MODEL_DEFAULT;
  assert.equal(
    pinned,
    "gemini-embedding-001",
    "MODEL_VERSION in scripts/backfill-embeddings.mjs is CAPS.GEMINI_EMBEDDING_MODEL_DEFAULT; " +
      "if this changes, the SITE 4 refutation must be re-derived, not assumed",
  );
  assert.notEqual(
    pinned,
    "qwen3-embedding-8b-fp16",
    "the census attributed readSidecar's read to the qwen3 sidecar; the code cannot " +
      "compute that path",
  );
  const resolved = join(GH_ROOT, "indices", pinned, "embeddings-sidecar.jsonl");
  assert.equal(
    resolved,
    join(GH_ROOT, "indices", "gemini-embedding-001", "embeddings-sidecar.jsonl"),
    "sidecarPathFor(MODEL_VERSION) has no wildcard model segment",
  );
});
