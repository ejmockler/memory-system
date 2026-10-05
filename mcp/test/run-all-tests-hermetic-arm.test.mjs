// run-all-tests-hermetic-arm.test.mjs — FU3 (memperf) hermetic-arm regression.
//
// WHAT THIS PINS: the REG gate de-flake in mcp/scripts/run-all-tests.mjs
// depends on runOne spawning every suite with REQUIRE_HERMETIC="1" injected
// into the child env (env: { ...process.env, REQUIRE_HERMETIC: "1" }). If
// someone reverts that to `env: process.env`, every skipIfDaemonActive suite
// silently regains its vacuous-pass branch under gate runs ("0 passed,
// 0 failed" exit 0 while the watermark daemon is active) and NOTHING fails.
// This suite closes that hole from both sides:
//
//   (a) STATIC ARM — the runner source's runOne spawn call must inject
//       REQUIRE_HERMETIC:"1" while spreading process.env. Anchored to the
//       runOne block so a revert to `env: process.env` (or moving the
//       injection out of the spawn call) fails the match.
//   (b) DYNAMIC MATRIX — the real test/_hermetic-daemon-skip.mjs helper is
//       exercised in CHILD processes via its _stateFilesForTest seam
//       (temp state files only — the production storage/watermark-state
//       list is never stat'ed here):
//         fresh mtime + REQUIRE_HERMETIC=1   -> hard failure (exit 1, the
//                                               vacuous-pass FAIL wording)
//         fresh mtime + REQUIRE_HERMETIC unset -> clean skip (exit 0, the
//                                               "0 passed, 0 failed" line)
//         stale mtime (>30s)                 -> run-through (helper returns,
//                                               driver marker printed, exit 0)
//   (c)(d)(e) e18 DERIVATION + TIERING — the helper's state-file set is no
//       longer three hardcoded paths but is DERIVED from CAPS.WATERMARK_SOURCES
//       and split into a WATCHED tier (all declared sources, sampled by the
//       exit post-check) and a GATING tier (what a suite actually waits on).
//       (c) pins the derivation, (d) pins each source's tier against the real
//       CAPS-derived constants, and (e1)/(e2) pin the behavioral consequence:
//       a fresh NOTE-tier file must let the suite RUN, and must still be NAMED
//       at exit if it moves mid-suite. Full argument in the helper's header.
//
// MUTATION CHECK (RED-RUN RECORD 2026-07-17, this workspace — scratch copy
// only, the live runner was never edited): a copy of run-all-tests.mjs with
// the spawn env reverted to `env: process.env`, pointed at via the
// HERMETIC_ARM_RUNNER_PATH_FOR_TEST seam, fails (a) verbatim:
//
//   ✖ (a) static arm: runOne spawns suites with REQUIRE_HERMETIC="1" injected over process.env
//     AssertionError [ERR_ASSERTION]: runOne's spawn env must inject
//     REQUIRE_HERMETIC:"1" over a ...process.env spread (env: { ...process.env,
//     REQUIRE_HERMETIC: "1" }) — a revert to `env: process.env` re-opens the
//     vacuous-pass hole ...
//
// while the same test passes against the real runner. The dynamic matrix is
// self-evidently non-vacuous: each case asserts a specific exit code AND a
// specific output marker (never mere child completion).
//
// Hermetic: mkdtempSync temp tree only; the driver child imports the REAL
// helper module but is handed ONLY a temp state file. Production
// memory.jsonl, indices, and storage/watermark-state files are never read,
// written, or mtime-touched.

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const MCP_ROOT = join(import.meta.dirname, "..");

// Test-only seam (codebase convention, cf. _stateFilesForTest in
// _hermetic-daemon-skip.mjs): the mutation check points this at a SCRATCH
// COPY of the runner with the env injection reverted — the live runner is
// never edited for red runs. Unset (every real run) it targets the real
// runner source.
const RUNNER_PATH =
  process.env.HERMETIC_ARM_RUNNER_PATH_FOR_TEST ||
  join(MCP_ROOT, "scripts", "run-all-tests.mjs");

// e18: same seam shape as HERMETIC_ARM_RUNNER_PATH_FOR_TEST above. The
// tiering red-run points this at a SCRATCH COPY of the helper (e.g. one with
// mail forced into the NOTE tier) so the mutation check never edits the live
// file. Unset — every real run — it targets the real helper.
const HELPER_PATH =
  process.env.HERMETIC_ARM_HELPER_PATH_FOR_TEST ||
  join(MCP_ROOT, "test", "_hermetic-daemon-skip.mjs");

// Importing the helper module is side-effect-free: it derives two frozen path
// lists from CAPS and defines functions. skipIfDaemonActive is NOT called by
// the import, so this suite does not gate itself twice.
const helper = await import(pathToFileURL(HELPER_PATH).href);

const TMP_ROOT = mkdtempSync(join(tmpdir(), "harm-"));
process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ---------------------------------------------------------------------------
// (a) STATIC ARM — the runner's runOne spawn env injects REQUIRE_HERMETIC:"1".
// ---------------------------------------------------------------------------
test('(a) static arm: runOne spawns suites with REQUIRE_HERMETIC="1" injected over process.env', () => {
  const src = readFileSync(RUNNER_PATH, "utf8");

  // Anchor to the runOne block (the per-suite spawn chokepoint) so the
  // assertion cannot be satisfied by a stray comment elsewhere in the file.
  const runOneStart = src.indexOf("function runOne");
  assert.notEqual(
    runOneStart,
    -1,
    `runner at ${RUNNER_PATH} must define runOne (the per-suite spawn chokepoint)`,
  );
  const runOneEnd = src.indexOf("\nfunction ", runOneStart + 1);
  const runOneBlock = src.slice(
    runOneStart,
    runOneEnd === -1 ? src.length : runOneEnd,
  );
  assert.match(
    runOneBlock,
    /spawnSync\(/,
    "runOne must spawn the suite child (spawnSync)",
  );

  // The load-bearing shape: spread process.env AND inject REQUIRE_HERMETIC:"1"
  // in the spawn options. `env: process.env` (the pre-REGINT revert) does NOT
  // match; dropping the spread (which would starve suites of PATH etc.)
  // does not match either.
  assert.match(
    runOneBlock,
    /env:\s*\{\s*\.\.\.process\.env\s*,\s*REQUIRE_HERMETIC:\s*"1"\s*,?\s*\}/,
    'runOne\'s spawn env must inject REQUIRE_HERMETIC:"1" over a ' +
      "...process.env spread (env: { ...process.env, REQUIRE_HERMETIC: \"1\" }) " +
      "— a revert to `env: process.env` re-opens the vacuous-pass hole where " +
      "daemon-active suites skip with exit 0 inside gate runs",
  );
});

// ---------------------------------------------------------------------------
// (b) DYNAMIC MATRIX — the helper's three behaviors, in child processes,
// against TEMP state files only (via the _stateFilesForTest seam).
// ---------------------------------------------------------------------------

const DRIVER_PATH = join(TMP_ROOT, "hermetic-arm-driver.mjs");
const RUN_THROUGH_MARKER = "HERMETIC_ARM_RAN_THROUGH";
// Import the REAL helper (absolute file URL: the driver lives in the temp
// tree, so a relative specifier cannot reach the repo).
writeFileSync(
  DRIVER_PATH,
  [
    "// hermetic-arm driver — exercises the real skipIfDaemonActive against",
    "// the ONE temp state file passed as argv[2] (the _stateFilesForTest seam).",
    `import { skipIfDaemonActive } from ${JSON.stringify(pathToFileURL(HELPER_PATH).href)};`,
    'skipIfDaemonActive("hermetic-arm-matrix", [process.argv[2]]);',
    `console.log(${JSON.stringify(RUN_THROUGH_MARKER)});`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);

let caseSeq = 0;
function runDriver({ stateMtimeAgoMs, requireHermetic, quiesce = {} }) {
  const stateFile = join(TMP_ROOT, `state-${caseSeq++}.json`);
  writeFileSync(stateFile, '{"cursor":"test"}\n', { mode: 0o600 });
  if (stateMtimeAgoMs > 0) {
    const past = new Date(Date.now() - stateMtimeAgoMs);
    utimesSync(stateFile, past, past);
  }
  // The parent may itself be running under the gate runner (REQUIRE_HERMETIC
  // already set), so the child env is built explicitly per case. The quiesce
  // knobs are likewise set explicitly per case — inheriting an operator's
  // HERMETIC_QUIESCE_* from the ambient environment would make these cases
  // measure the operator's shell rather than the helper.
  const env = { ...process.env };
  delete env.REQUIRE_HERMETIC;
  delete env.HERMETIC_QUIESCE_WINDOW_MS;
  delete env.HERMETIC_QUIESCE_BUDGET_MS;
  if (requireHermetic) env.REQUIRE_HERMETIC = "1";
  if (quiesce.windowMs != null)
    env.HERMETIC_QUIESCE_WINDOW_MS = String(quiesce.windowMs);
  if (quiesce.budgetMs != null)
    env.HERMETIC_QUIESCE_BUDGET_MS = String(quiesce.budgetMs);
  const res = spawnSync(process.execPath, [DRIVER_PATH, stateFile], {
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

// e10 RE-EXPRESSION OF (b1). Before e10 this case read "fresh mtime +
// REQUIRE_HERMETIC=1 => immediate exit 1", and the word doing the work was
// IMMEDIATE: the helper judged one instantaneous mtime sample, so a file
// written milliseconds ago was a verdict. Under quiesce-and-wait a fresh file
// that then goes QUIET is no longer a failure — the helper waits for a real
// quiet window and runs through — so the old phrasing would now pin the
// opposite of the intended contract.
//
// What (b1) still has to pin is the thing that must never regress: when the
// daemon cannot be waited out, the armed branch is a LOUD FAILURE and never a
// vacuous pass. HERMETIC_QUIESCE_BUDGET_MS=0 drives exactly that branch
// deterministically — the patience budget is exhausted before the first poll,
// so no quiet window can ever be found — and the assertions below are
// otherwise unchanged: exit 1, the same vacuous-pass wording, the same
// REQUIRE_HERMETIC=1 mention, and no run-through.
test("(b1) fresh state file + REQUIRE_HERMETIC=1 + exhausted quiesce budget: hard failure (exit 1) with the vacuous-pass FAIL wording", () => {
  const r = runDriver({
    stateMtimeAgoMs: 0,
    requireHermetic: true,
    quiesce: { budgetMs: 0 },
  });
  assert.equal(
    r.status,
    1,
    `armed daemon-active branch must exit 1 (got ${r.status}); stdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
  );
  assert.ok(
    r.stderr.includes("would be a vacuous pass"),
    `stderr must carry the vacuous-pass FAIL wording (got:\n${r.stderr})`,
  );
  assert.ok(
    r.stderr.includes("REQUIRE_HERMETIC=1"),
    `stderr must name the arming env var (got:\n${r.stderr})`,
  );
  assert.ok(
    !r.stdout.includes(RUN_THROUGH_MARKER),
    "the driver must never run through past an armed daemon-active state",
  );
});

test("(b2) fresh state file + REQUIRE_HERMETIC unset: clean skip (exit 0) with the '0 passed, 0 failed' line", () => {
  const r = runDriver({ stateMtimeAgoMs: 0, requireHermetic: false });
  assert.equal(
    r.status,
    0,
    `local-dev daemon-active skip must exit 0 (got ${r.status}); stderr:\n${r.stderr}`,
  );
  assert.ok(
    r.stdout.includes("0 passed, 0 failed (skipped — daemon-active)"),
    `stdout must carry the exact skip tally line (got:\n${r.stdout})`,
  );
  assert.ok(
    !r.stdout.includes(RUN_THROUGH_MARKER),
    "the skip branch must exit before the test body runs",
  );
});

test("(b3) stale state file (>30s): helper returns and the suite runs through (exit 0, marker printed)", () => {
  // 120s in the past — comfortably past DAEMON_ACTIVE_THRESHOLD_MS (30s).
  const r = runDriver({ stateMtimeAgoMs: 120_000, requireHermetic: true });
  assert.equal(
    r.status,
    0,
    `stale state file must not trip the gate (got exit ${r.status}); stderr:\n${r.stderr}`,
  );
  assert.ok(
    r.stdout.includes(RUN_THROUGH_MARKER),
    `driver must run through past skipIfDaemonActive (got stdout:\n${r.stdout})`,
  );
  assert.ok(
    !r.stdout.includes("skipped — daemon-active"),
    "a stale state file must not be treated as daemon-active",
  );
});

// ---------------------------------------------------------------------------
// (b4) e10 — the NEW contract quiesce-and-wait introduces.
//
// A state file that is FRESH at first sample but is then NOT WRITTEN AGAIN is
// a quiet daemon, and a quiet daemon is exactly the condition these suites
// need. The pre-e10 helper failed this case on principle: it read the one
// fresh mtime and refused. This case pins that the helper now waits, observes
// the quiet window close, and runs the suite.
//
// It is also the non-vacuity partner to (b1): (b1) proves the loud failure
// still fires when the budget cannot be met, (b4) proves the wait can actually
// SUCCEED. Together they show the fix moved WHEN the failure fires without
// removing the failure — a change that only ever passed would be a regression
// of the hermetic-or-fail contract, not a de-flake.
//
// Window 300ms / budget 8000ms keeps the case fast while preserving the shape
// (budget comfortably greater than window). The driver never touches the file
// after creating it, so the window closes on the first poll boundary past W.
test("(b4) fresh state file that then stays quiet: helper waits out the window and runs through (exit 0)", () => {
  const r = runDriver({
    stateMtimeAgoMs: 0,
    requireHermetic: true,
    quiesce: { windowMs: 300, budgetMs: 8000 },
  });
  assert.equal(
    r.status,
    0,
    `a daemon that goes quiet must be waited out, not failed (got exit ${r.status}); stdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
  );
  assert.ok(
    r.stdout.includes(RUN_THROUGH_MARKER),
    `driver must run through after the quiet window closes (got stdout:\n${r.stdout})`,
  );
  assert.ok(
    r.stdout.includes("HERMETIC_QUIESCE"),
    `the helper must SAY it waited, so a slow suite is attributable (got stdout:\n${r.stdout})`,
  );
  assert.ok(
    !r.stdout.includes("skipped — daemon-active"),
    "a daemon that quiesced must not be reported as active",
  );
  assert.ok(
    !r.stderr.includes("would be a vacuous pass"),
    `a successful quiesce must not emit the hard-failure wording (got stderr:\n${r.stderr})`,
  );
});

// ---------------------------------------------------------------------------
// (c)(d)(e) e18 — the DERIVED, TIERED state-file set.
//
// WHAT BROKE, AND WHY A PIN IS THE RIGHT SHAPE. Before e18 the helper carried
// three hardcoded cursor paths. Seven cascade sources shipped after it was
// written and none of them was added, so the gate silently stopped covering
// most of the daemon — e16-R2 spent a red run on mail, a source the gate could
// not see. A hardcode that drifts silently is exactly the thing a pin exists
// to catch: these cases fail the moment the helper's set stops being derived
// from CAPS, or the moment a source lands in the wrong tier.
//
// RED-RUN RECORD (2026-08-26, this workspace — scratch copy only, the live
// helper was never edited): a copy of _hermetic-daemon-skip.mjs with "mail"
// appended to ENDOGENOUS_SOURCES (forcing it into the NOTE tier), pointed at
// via the HERMETIC_ARM_HELPER_PATH_FOR_TEST seam, fails (d) verbatim:
//
//   AssertionError [ERR_ASSERTION]: mail must GATE — it is a live cascade
//   source (and the e16-R2 byte-identity culprit); demoting it to the note
//   tier restores the exact blind spot e18 closed
//
// while the same case passes against the real helper.
// ---------------------------------------------------------------------------

// Checkout-anchored, derived exactly as the helper derives its own state dir
// (two levels above the helper file), so (c)/(d) pin the helper's tiers at any
// checkout path.
const STATE_DIR_PREFIX =
  join(dirname(HELPER_PATH), "..", "..", "storage", "watermark-state") + "/";
const baseName = (p) => p.slice(p.lastIndexOf("/") + 1);

// ---------------------------------------------------------------------------
// (c) DERIVATION — deriveStateFiles is pure and follows the declared list.
// ---------------------------------------------------------------------------
test("(c) derivation: deriveStateFiles follows the declared source list, drops wildcards, and picks up unknown sources automatically", () => {
  // A synthetic declaration: a wildcard entry that must be dropped, the real
  // tier members, and a FABRICATED source that exists nowhere in the codebase.
  // The fabricated entry is the load-bearing one — it proves the set is
  // derived rather than enumerated, i.e. that a future CAPS.WATERMARK_SOURCES
  // edit needs no second edit in the helper.
  const sources = [
    "chat-claude-code",
    "chat-claude-code-*",
    "imessage",
    "screentime",
    "codex-cli",
    "quokka-connector", // fabricated tenth source
  ];
  const { watched, gating } = helper.deriveStateFiles(
    sources,
    ["screentime"],
    ["chat-claude-code", "codex-cli"],
  );

  assert.ok(
    watched.includes(`${STATE_DIR_PREFIX}quokka-connector.json`),
    "a source the helper has never heard of must appear in `watched` purely " +
      `because it was declared (got: ${watched.join(", ")})`,
  );
  assert.ok(
    gating.includes(`${STATE_DIR_PREFIX}quokka-connector.json`),
    "an undeclared-tier source must GATE by default — new sources are " +
      "hazardous until argued otherwise, never silently exempt",
  );
  assert.ok(
    !watched.some((p) => p.includes("*")) && !gating.some((p) => p.includes("*")),
    'trailing-"*" wildcard entries are batch-pipeline patterns, not cursor ' +
      "names; stat'ing a literal chat-claude-code-*.json would watch nothing " +
      `forever (got watched: ${watched.join(", ")})`,
  );
  assert.deepEqual(
    watched.map(baseName),
    [
      "chat-claude-code.json",
      "imessage.json",
      "screentime.json",
      "codex-cli.json",
      "quokka-connector.json",
    ],
    "watched must be exactly the non-wildcard declared sources, in declared order",
  );
  assert.deepEqual(
    gating.map(baseName),
    ["imessage.json", "quokka-connector.json"],
    "gating must be watched minus captured-only minus endogenous",
  );

  // Purity: the function must not read CAPS or module state, so an empty
  // declaration yields empty tiers rather than the production set.
  assert.deepEqual(
    helper.deriveStateFiles([], [], []),
    { watched: [], gating: [] },
    "deriveStateFiles must be pure — an empty declaration cannot fall back " +
      "to the production list",
  );
});

// ---------------------------------------------------------------------------
// (d) TIERING — the REAL CAPS-derived constants, source by source.
// ---------------------------------------------------------------------------
test("(d) tiering: WATCHED is every declared source, GATING excludes exactly the captured-only and endogenous ones", () => {
  const watched = helper.WATCHED_STATE_FILES.map(baseName);
  const gating = helper.GATING_STATE_FILES.map(baseName);

  assert.ok(
    gating.every((f) => watched.includes(f)),
    `WATCHED must be a superset of GATING (watched: ${watched.join(", ")} | ` +
      `gating: ${gating.join(", ")})`,
  );

  // NOTE tier: watched so armPostCheck can attribute, never gating.
  assert.ok(
    watched.includes("screentime.json") && !gating.includes("screentime.json"),
    "screentime is CAPS.WATERMARK_CAPTURED_ONLY_SOURCES — tickSourcesOnce " +
      "`continue`s before readSourceCursor, so its cursor structurally cannot " +
      "advance from cascade. A file that cannot move must not be able to block.",
  );
  assert.ok(
    watched.includes("chat-claude-code.json") &&
      !gating.includes("chat-claude-code.json"),
    "chat-claude-code is an endogenous agent-runtime source: the agent " +
      "driving this gate writes the ledger it tails, so gating on it is the " +
      "harness waiting out its own operator. Watched (attribution), never " +
      "gating (livelock).",
  );
  assert.ok(
    watched.includes("codex-cli.json") && !gating.includes("codex-cli.json"),
    "codex-cli is an endogenous agent-runtime source — same livelock argument " +
      "as chat-claude-code",
  );

  // GATE tier: the live cascade sources a suite must actually wait on.
  for (const f of [
    "mail.json",
    "whatsapp.json",
    "telegram.json",
    "github-events.json",
    "slack.json",
    "imessage.json",
    "git-log.json",
  ]) {
    assert.ok(
      gating.includes(f),
      `${f.replace(".json", "")} must GATE — it is a live cascade source ` +
        "(and the e16-R2 byte-identity culprit); demoting it to the note tier " +
        "restores the exact blind spot e18 closed",
    );
  }

  // The wildcard entry must survive in neither tier.
  assert.ok(
    !watched.some((f) => f.includes("*")) && !gating.some((f) => f.includes("*")),
    'the "chat-claude-code-*" wildcard declaration must appear in neither tier',
  );

  // The one NEW constant e18 introduces. Pinned by name so that adding a
  // source to it is a deliberate, visible act rather than a quiet demotion:
  // every entry here is a source the gate stops waiting on.
  assert.deepEqual(
    [...helper.ENDOGENOUS_SOURCES],
    ["chat-claude-code", "codex-cli"],
    "ENDOGENOUS_SOURCES is the argued demotion list (agent-runtime hook " +
      "sources the gate cannot wait out). Growing it silently narrows the " +
      "gate; each addition needs the livelock argument made in the helper header.",
  );

  // NOTE tier is exactly the complement — no source may be in neither tier,
  // and none may be silently dropped from attribution.
  assert.deepEqual(
    helper.NOTE_STATE_FILES.map(baseName).slice().sort(),
    watched.filter((f) => !gating.includes(f)).slice().sort(),
    "NOTE_STATE_FILES must be exactly WATCHED minus GATING — a source that " +
      "gates nothing and is watched by nothing would be invisible in both " +
      "directions",
  );

  // Shape, so a silent collapse of the tiers (gating := watched) is caught.
  assert.equal(
    watched.length,
    10,
    `all ten non-wildcard declared sources must be watched (got ${watched.length}: ${watched.join(", ")})`,
  );
  assert.equal(
    gating.length,
    7,
    `exactly seven sources may gate (got ${gating.length}: ${gating.join(", ")})`,
  );
});

// ---------------------------------------------------------------------------
// (e) NOTE-FRESH / GATE-STALE — the behavioral consequence of the tiering,
// driven through the object form of the _stateFilesForTest seam.
//
// The ARRAY form is untouched and still means "both tiers" — cases (b1)-(b4)
// above depend on exactly that and are unmodified.
// ---------------------------------------------------------------------------

const TIER_DRIVER_PATH = join(TMP_ROOT, "hermetic-arm-tier-driver.mjs");
const TIER_TOUCHED_MARKER = "HERMETIC_ARM_TIER_TOUCHED_NOTE";
writeFileSync(
  TIER_DRIVER_PATH,
  [
    "// hermetic-arm tier driver — argv[2] = NOTE-tier file, argv[3] = GATE-tier",
    "// file, argv[4] = 'touch' to advance the note file after the gate returns.",
    'import { utimesSync } from "node:fs";',
    `import { skipIfDaemonActive } from ${JSON.stringify(pathToFileURL(HELPER_PATH).href)};`,
    "const note = process.argv[2];",
    "const gate = process.argv[3];",
    'skipIfDaemonActive("hermetic-arm-tiering", { watched: [note, gate], gating: [gate] });',
    'if (process.argv[4] === "touch") {',
    "  // Deterministically DIFFERENT mtime — the daemon-writes-mid-suite case.",
    "  const t = new Date(Date.now() - 3000);",
    "  utimesSync(note, t, t);",
    `  console.log(${JSON.stringify(TIER_TOUCHED_MARKER)});`,
    "}",
    `console.log(${JSON.stringify(RUN_THROUGH_MARKER)});`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);

function runTierDriver({ touch = false } = {}) {
  const noteFile = join(TMP_ROOT, `note-${caseSeq++}.json`);
  const gateFile = join(TMP_ROOT, `gate-${caseSeq++}.json`);
  writeFileSync(noteFile, '{"cursor":"note"}\n', { mode: 0o600 });
  writeFileSync(gateFile, '{"cursor":"gate"}\n', { mode: 0o600 });
  // NOTE tier: fresh (mtime = now). GATE tier: 120s stale, comfortably past
  // DAEMON_ACTIVE_THRESHOLD_MS.
  const past = new Date(Date.now() - 120_000);
  utimesSync(gateFile, past, past);

  const env = { ...process.env };
  delete env.HERMETIC_QUIESCE_WINDOW_MS;
  delete env.HERMETIC_QUIESCE_BUDGET_MS;
  env.REQUIRE_HERMETIC = "1";
  const res = spawnSync(
    process.execPath,
    [TIER_DRIVER_PATH, noteFile, gateFile, touch ? "touch" : "no-touch"],
    { env, encoding: "utf8", timeout: 30_000 },
  );
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    noteFile,
    gateFile,
  };
}

test("(e1) note-tier file FRESH + gate-tier file STALE + REQUIRE_HERMETIC=1: the suite RUNS THROUGH (exit 0, marker) — it must never skip and never exit 1", () => {
  const r = runTierDriver();
  assert.equal(
    r.status,
    0,
    `a fresh NOTE-tier file must not block: the gate tier was stale, so the ` +
      `suite must run (got exit ${r.status}); stdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
  );
  assert.ok(
    r.stdout.includes(RUN_THROUGH_MARKER),
    `driver must run through past skipIfDaemonActive (got stdout:\n${r.stdout})`,
  );
  // The invariant narrowing the gate must never touch: a narrowed gate may
  // make a suite RUN, it may never make one SKIP.
  assert.ok(
    !r.stdout.includes("0 passed, 0 failed"),
    "narrowing the gate must never reopen the vacuous-pass skip branch " +
      `(got stdout:\n${r.stdout})`,
  );
  assert.ok(
    !r.stderr.includes("would be a vacuous pass"),
    `a stale gate tier must not produce the hard-failure wording (got stderr:\n${r.stderr})`,
  );
});

test("(e2) note-tier file advancing DURING the suite: the exit post-check NAMES it (attribution survives the narrowed gate)", () => {
  const r = runTierDriver({ touch: true });
  assert.equal(
    r.status,
    0,
    `armPostCheck prints and must NEVER touch the exit code (got exit ${r.status}); stderr:\n${r.stderr}`,
  );
  assert.ok(
    r.stdout.includes(TIER_TOUCHED_MARKER) && r.stdout.includes(RUN_THROUGH_MARKER),
    `driver must have advanced the note file and run to completion (got stdout:\n${r.stdout})`,
  );
  assert.ok(
    r.stdout.includes("HERMETIC_POST_CHECK"),
    "a watched file that moved during the suite must be reported at exit — " +
      "this is what makes narrowing the GATE safe: the note tier is still " +
      `watched (got stdout:\n${r.stdout})`,
  );
  assert.ok(
    r.stdout.includes(baseName(r.noteFile)),
    `the post-check must NAME the offending file, not just count it (got stdout:\n${r.stdout})`,
  );
});
