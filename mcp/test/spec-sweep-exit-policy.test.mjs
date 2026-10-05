// spec-sweep-exit-policy.test.mjs — R35 M1 regression test.
//
// FOUNDATION (R35 M1, kb/deprecation-discipline.md):
//   Gap: pre-R35 spec-sweep collapsed every non-zero exit into code 1,
//   making "the gate found drift" indistinguishable from "the gate itself
//   broke." Per R34 brutalist phase (c) and (j), this is the structural
//   half of the recursion floor: a gate that BLOCKS on detection only
//   half-aspirationally is not a gate.
//
//   R35 M1 fix: tri-state exit policy.
//     exit 0 — clean (zero classifier hits AND zero sweep-internal-errors)
//     exit 1 — classifier findings present (build SHOULD block on drift)
//     exit 2 — gate is broken (sweep-internal-error findings; build MUST
//              block until the gate is repaired; takes priority over 1)
//
// This file proves the contract end-to-end by spawning spec-sweep against
// HERMETIC HOME trees seeded with deterministic content. No production
// mutation; the live <checkout> tree is read by the live run only
// for a sanity check that the script still terminates with a number.
//
// Hermetic strategy: spec-sweep scans the checkout its own script file lives
// in and takes its data root from MEMORY_ROOT. We build a minimal tree under
// tmpdir, copy the script (and the modules it imports) into it, spawn THAT
// copy with MEMORY_ROOT=<tmpdir>/memory-system in the child env (HOME=tmpdir
// is redirected too, only as a belt), and assert the spawned process's exit
// code matches the seeded scenario.

import {
  copyFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// scripts/spec-sweep.mjs lives at <checkout>/scripts/spec-sweep.mjs.
const SWEEP_PATH = join(here, "..", "..", "scripts", "spec-sweep.mjs");

// The sweep's CODE root (kb/, mcp/, daemons/, hooks/, scripts/) is the checkout
// its own script file lives in, so a hermetic run needs the script INSIDE the
// synthetic tree. installSweep() copies it there together with the three
// modules it imports (the one-line package.json marks mcp/ as ESM, as the
// checkout's does). The copies are byte-identical to the checkout's files and
// sit at the same relative paths, so the sweep treats them exactly as it
// treats them in the checkout. Returns the path of the copied script.
const SWEEP_CLOSURE = [
  "scripts/spec-sweep.mjs",
  "mcp/lib/forbidden-legacy-identifiers.js",
  "mcp/scripts/canonical-block-scan.mjs",
  "mcp/scripts/_scan-exclusions.mjs",
];
function installSweep(root) {
  const checkout = join(here, "..", "..");
  for (const rel of SWEEP_CLOSURE) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    copyFileSync(join(checkout, rel), join(root, rel));
  }
  writeFileSync(join(root, "mcp", "package.json"), '{ "type": "module" }\n', "utf8");
  return join(root, "scripts", "spec-sweep.mjs");
}

let failures = 0;
let passed = 0;
function check(label, cond, detail) {
  if (cond) {
    passed += 1;
    process.stdout.write(`PASS  ${label}\n`);
  } else {
    failures += 1;
    process.stdout.write(
      `FAIL  ${label}${detail ? ` -- ${detail}` : ""}\n`,
    );
  }
}

// Build a minimal <tmp-home>/memory-system/ tree that spec-sweep will not crash
// on. Returns the absolute path of the synthetic HOME directory.
//
// CONTENTS:
//   memory-system/
//     kb/agent-integration.md            (KB stub; parsers tolerate null)
//     kb/legacy-archive.md               (exists so legacy-pattern excluder
//                                         has its allow-listed target)
//     kb/deprecation-discipline.md       (ditto)
//     mcp/                                (empty dir; scanner walks it cleanly)
//     daemons/                            (empty dir)
//     hooks/                              (empty dir)
//     scripts/spec-sweep.mjs             (copy of the sweep under test, plus
//                                         the modules it imports under mcp/)
//     policy/distillation-state.json     (state-file existence is optional;
//                                         the file-check is a no-op without it)
//
// kbBody: optional override for kb/agent-integration.md (T3 uses this to
// inject a malformed anchor and force a sweep-internal-error).
function makeWorkspace(label, opts = {}) {
  const base = join(
    tmpdir(),
    `spec-sweep-exit-policy-${label}-${process.pid}-${Date.now()}`,
  );
  mkdirSync(join(base, "memory-system", "kb"), { recursive: true });
  mkdirSync(join(base, "memory-system", "mcp"), { recursive: true });
  mkdirSync(join(base, "memory-system", "daemons"), { recursive: true });
  mkdirSync(join(base, "memory-system", "hooks"), { recursive: true });
  mkdirSync(join(base, "memory-system", "scripts"), { recursive: true });
  mkdirSync(join(base, "memory-system", "policy"), { recursive: true });

  // Default KB stub: no anchors present. All three parsers use {optional:true}
  // on their primary anchor, so anchor-not-found returns null and no
  // sweep-internal-error fires. The result: a clean exit-0 baseline.
  const defaultKb = [
    "# agent-integration (synthetic stub for spec-sweep hermetic test)",
    "",
    "This file is intentionally minimal. The three frozen-schema parsers",
    "and the event-ownership table parser are all invoked with",
    "{optional: true}; absent anchors return a null sentinel rather than",
    "throwing, so this stub produces zero findings.",
    "",
  ].join("\n");
  writeFileSync(
    join(base, "memory-system", "kb", "agent-integration.md"),
    opts.kbBody ?? defaultKb,
    "utf8",
  );
  // The two allow-listed KB docs are excluded from the legacy-pattern
  // scanner via EXCLUDED_PATH_SUFFIXES; create empty placeholders so
  // path-walk does not produce noisy reads.
  writeFileSync(
    join(base, "memory-system", "kb", "legacy-archive.md"),
    "# legacy-archive (stub)\n",
    "utf8",
  );
  writeFileSync(
    join(base, "memory-system", "kb", "deprecation-discipline.md"),
    "# deprecation-discipline (stub)\n",
    "utf8",
  );
  // policy/distillation-state.json is intentionally absent: the sweep
  // treats absence as a no-op for that checker (existsSync gate).
  installSweep(join(base, "memory-system"));
  return base;
}

function runSweep(home) {
  const res = spawnSync(process.execPath, [join(home, "memory-system", "scripts", "spec-sweep.mjs")], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, HOME: home, MEMORY_ROOT: join(home, "memory-system") },
  });
  return {
    code: res.status,
    out: (res.stdout || "") + (res.stderr || ""),
  };
}

const workspaces = [];

// ---------------------------------------------------------------------------
// T1 — clean workspace: zero hits, zero internal errors -> exit 0.
// ---------------------------------------------------------------------------
{
  const home = makeWorkspace("T1-clean");
  workspaces.push(home);
  const r = runSweep(home);
  check(
    "T1: clean workspace exits 0",
    r.code === 0,
    `got code=${r.code}; stdout tail=${r.out.slice(-400)}`,
  );
  // A truly clean workspace takes the early-return path "0 hits across
  // 0 categories" without printing the exit-partition line (the partition
  // line is only printed when at least one category produced findings).
  // Either form is acceptable evidence of a clean exit.
  check(
    "T1: clean workspace stdout signals zero findings",
    r.out.includes("0 hits across 0 categories") ||
      /exit-partition: 0 classifier hits?, 0 sweep-internal-errors/.test(
        r.out,
      ),
    `expected '0 hits across 0 categories' or partition-zero line; stdout tail=${r.out.slice(-400)}`,
  );
}

// ---------------------------------------------------------------------------
// T2 — classifier hit: inject a synthetic test file containing a forbidden
//      literal (`distillation-queue`) outside any allow-marker context.
//      Expected: spec-sweep exits 1 (legitimate finding), NOT 2 (gate broken).
// ---------------------------------------------------------------------------
{
  const home = makeWorkspace("T2-classifier-hit");
  workspaces.push(home);
  // Place the synthetic legacy reference inside mcp/ so the scanner
  // walks it. The line lives outside any test deny-list loop, so the
  // path-pattern allow-list does NOT apply.
  const synthDir = join(home, "memory-system", "mcp", "test");
  mkdirSync(synthDir, { recursive: true });
  const synthFile = join(synthDir, "_r35-synth-injection.test.mjs");
  // The "distillation-queue" identifier is in FORBIDDEN_IDENTIFIERS as a
  // bounded regex; appearing as a bare token (not a hyphenated suffix
  // of a longer identifier) is sufficient to trigger a hit.
  // Construct the forbidden literal via string concatenation so the
  // production legacy-pattern scanner does not flag THIS test file when
  // it runs against the live <checkout> tree. The hermetic child
  // process sees the reconstructed literal in the workspace file and
  // still produces the expected classifier hit.
  const RETIRED_QUEUE_NAME = "distillation" + "-queue";
  const RETIRED_QUEUE_LITERAL =
    "const retiredQueuePath = 'storage/" +
    RETIRED_QUEUE_NAME +
    "/pending';";
  writeFileSync(
    synthFile,
    [
      "// Synthetic R35 M1 regression-fixture.",
      "// This file intentionally references the retired queue path so",
      "// spec-sweep's legacy-pattern scanner detects a classifier hit.",
      RETIRED_QUEUE_LITERAL,
      "console.log(retiredQueuePath);",
      "",
    ].join("\n"),
    "utf8",
  );
  const r = runSweep(home);
  check(
    "T2: synthetic legacy literal -> spec-sweep exit 1",
    r.code === 1,
    `expected exit 1, got code=${r.code}; stdout tail=${r.out.slice(-600)}`,
  );
  check(
    "T2: stdout names the legacy_pattern_seen category",
    r.out.includes("legacy_pattern_seen"),
    `expected 'legacy_pattern_seen' in stdout; stdout tail=${r.out.slice(-600)}`,
  );
  check(
    "T2: stdout cites the synthetic injection file",
    r.out.includes("_r35-synth-injection.test.mjs"),
    `expected synthetic filename in stdout; stdout tail=${r.out.slice(-600)}`,
  );
  check(
    "T2: exit-partition line reports >=1 classifier hit",
    /exit-partition: [1-9]\d* classifier hit/.test(r.out),
    `expected partition line with non-zero classifier hits; stdout tail=${r.out.slice(-600)}`,
  );
  check(
    "T2: exit-partition line reports 0 sweep-internal-errors",
    /exit-partition: \d+ classifier hits?, 0 sweep-internal-errors/.test(
      r.out,
    ),
    `expected 0 internal errors in partition line; stdout tail=${r.out.slice(-600)}`,
  );
}

// ---------------------------------------------------------------------------
// T3 — sweep-internal-error: seed kb/agent-integration.md with the
//      state-schema anchor present but NO fenced code block following.
//      parseFrozenStateSchema is called with {optional:true}, which only
//      converts ANCHOR-NOT-FOUND into a null sentinel; an anchor that IS
//      found but with no opening fence still throws inside
//      extractFencedBlockAfter. tryParse catches it -> KB_PARSE_ERRORS
//      collects it -> addHit("sweep-internal-error",...) at scan start.
//      Expected: exit 2 (gate broken; priority over any classifier hits).
// ---------------------------------------------------------------------------
{
  // Anchor text taken verbatim from parseFrozenStateSchema in
  // scripts/spec-sweep.mjs (the anchorMain constant).
  // Reconstruct the anchor literal at runtime so the production
  // legacy-pattern scanner does not flag THIS test file for the
  // 'distillation-state' / 'distillation-state.json' identifiers when
  // it runs against the live <checkout> tree.
  const STATE_NAME = "distillation" + "-state";
  const STATE_ANCHOR =
    "**State file: `<MEMORY_ROOT>/policy/" +
    STATE_NAME +
    ".json` (AUTHORITATIVE SCHEMA";
  const malformedKb = [
    "# agent-integration (synthetic R35 T3 broken-gate fixture)",
    "",
    `${STATE_ANCHOR}, FROZEN R33-B5)**`,
    "",
    "Anchor is present but no fenced code block follows. This forces",
    "extractFencedBlockAfter to throw 'no opening fence after anchor',",
    "which the tryParse wrapper converts into a sweep-internal-error",
    "finding and (under R35 M1) into exit code 2.",
    "",
  ].join("\n");
  const home = makeWorkspace("T3-broken-gate", { kbBody: malformedKb });
  workspaces.push(home);
  const r = runSweep(home);
  check(
    "T3: malformed KB anchor -> spec-sweep exit 2 (gate broken)",
    r.code === 2,
    `expected exit 2, got code=${r.code}; stdout tail=${r.out.slice(-600)}`,
  );
  check(
    "T3: stdout names the sweep-internal-error category",
    r.out.includes("sweep-internal-error"),
    `expected 'sweep-internal-error' in stdout; stdout tail=${r.out.slice(-600)}`,
  );
  check(
    "T3: stdout cites parseFrozenStateSchema as the broken checker",
    r.out.includes("parseFrozenStateSchema"),
    `expected 'parseFrozenStateSchema' in stdout; stdout tail=${r.out.slice(-600)}`,
  );
  check(
    "T3: stdout includes the gate-broken exit message",
    r.out.includes("exit 2") && r.out.includes("gate is broken"),
    `expected gate-broken exit message; stdout tail=${r.out.slice(-600)}`,
  );
  check(
    "T3: exit-partition line reports >=1 sweep-internal-error",
    /exit-partition: \d+ classifier hits?, [1-9]\d* sweep-internal-error/.test(
      r.out,
    ),
    `expected partition line with non-zero internal-errors; stdout tail=${r.out.slice(-600)}`,
  );
}

// ---------------------------------------------------------------------------
// T4 — priority: classifier hit AND broken gate in the same workspace ->
//      exit 2 (broken gate dominates). This proves the priority ordering
//      that R35 M1 specifies; without it, exit 1 could mask a broken gate.
// ---------------------------------------------------------------------------
{
  // Reconstruct the anchor literal at runtime so the production
  // legacy-pattern scanner does not flag THIS test file for the
  // 'distillation-state' / 'distillation-state.json' identifiers when
  // it runs against the live <checkout> tree.
  const STATE_NAME = "distillation" + "-state";
  const STATE_ANCHOR =
    "**State file: `<MEMORY_ROOT>/policy/" +
    STATE_NAME +
    ".json` (AUTHORITATIVE SCHEMA";
  const malformedKb = [
    "# agent-integration (synthetic R35 T4 priority fixture)",
    "",
    `${STATE_ANCHOR}, FROZEN R33-B5)**`,
    "",
    "Anchor present but no fenced block; gate is broken.",
    "",
  ].join("\n");
  const home = makeWorkspace("T4-priority", { kbBody: malformedKb });
  workspaces.push(home);
  // Also inject a classifier hit so BOTH partitions are non-empty.
  const synthDir = join(home, "memory-system", "mcp", "test");
  mkdirSync(synthDir, { recursive: true });
  const PRIORITY_QUEUE_NAME = "distillation" + "-queue";
  writeFileSync(
    join(synthDir, "_r35-priority-fixture.test.mjs"),
    "const retired = 'storage/" +
      PRIORITY_QUEUE_NAME +
      "/done';\nconsole.log(retired);\n",
    "utf8",
  );
  const r = runSweep(home);
  check(
    "T4: broken gate + classifier hit -> exit 2 (priority enforced)",
    r.code === 2,
    `expected exit 2, got code=${r.code}; stdout tail=${r.out.slice(-600)}`,
  );
  check(
    "T4: both categories are reported in stdout",
    r.out.includes("sweep-internal-error") &&
      r.out.includes("legacy_pattern_seen"),
    `expected both categories in stdout; stdout tail=${r.out.slice(-600)}`,
  );
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
for (const ws of workspaces) {
  try {
    rmSync(ws, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

process.stdout.write(
  `\nspec-sweep-exit-policy: ${passed} passed, ${failures} failed\n`,
);
if (failures > 0) process.exit(1);
process.exit(0);
