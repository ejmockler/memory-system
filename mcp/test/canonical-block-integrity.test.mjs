// canonical-block-integrity.test.mjs
//
// R34 B12 self-test. Covers parseCanonicalBlocks, extractCanonical,
// scanTree + buildIndex, diffAgainstAllowlist, and the live invariant:
// every canonical block in this checkout's kb/ must be on the
// allowlist with a matching sha256.
//
// HERMETIC: all fixtures live in mkdtempSync under tmpdir(). No writes to
// storage/. No network.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import {
  parseCanonicalBlocks,
  extractCanonical,
  scanTree,
  buildIndex,
  diffAgainstAllowlist,
} from "../scripts/canonical-block-scan.mjs";
import { containsScratchSegment } from "../scripts/_scan-exclusions.mjs";

// The checkout that contains mcp/ — two directories above this file. The live
// invariants below run against THIS tree, wherever it was cloned.
const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

let pass = 0;
let fail = 0;
const failures = [];

function check(label, cond, detail) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push({ label, detail });
    console.error(`FAIL  ${label}${detail ? `\n      ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// FIXTURE 5 (R36 S2 / B13): gate-guarding-the-gates self-hash sentinel.
//
// The R35 floor protected every CANONICAL block via canonical-allowlist.json.
// But the allowlist itself was NOT under structural protection — an operator
// could silently mutate an entry's sha256 to silence an unintended content
// drift, and the gate would pass. R36 closes this meta-recursion: the raw
// file sha256 of canonical-allowlist.json is mirrored in
// mcp/policy/canonical-allowlist.sha256.sentinel, and the two MUST match.
// Any allowlist edit MUST be paired with `bash mcp/scripts/update-allowlist-sentinel.sh`
// or this assertion BLOCKs.
// ---------------------------------------------------------------------------
{
  const allowlistPath = join(REPO_ROOT, "mcp/policy/canonical-allowlist.json");
  const sentinelPath = join(REPO_ROOT, "mcp/policy/canonical-allowlist.sha256.sentinel");

  check(
    "B13 FIXTURE 5a: canonical-allowlist.sha256.sentinel exists",
    existsSync(sentinelPath),
    `expected file at ${sentinelPath}; run: bash mcp/scripts/update-allowlist-sentinel.sh`,
  );

  if (existsSync(allowlistPath) && existsSync(sentinelPath)) {
    const allowlistBytes = readFileSync(allowlistPath);
    const computedHash = createHash("sha256").update(allowlistBytes).digest("hex");
    const sentinelHash = readFileSync(sentinelPath, "utf8").trim();
    check(
      "B13 FIXTURE 5b: sentinel sha256 matches canonical-allowlist.json file hash",
      computedHash === sentinelHash,
      `B13: canonical-allowlist.json was modified without sentinel update (sha256 mismatch). This is the gate guarding the gates. If this is intentional, update the sentinel via: bash mcp/scripts/update-allowlist-sentinel.sh\n      computed=${computedHash} sentinel=${sentinelHash}`,
    );
  }
}

// ---------------------------------------------------------------------------
// FIXTURE 1: well-formed block parses, sha256 stable.
// ---------------------------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), "r34-b12-"));
const fixDir = join(tmp, "kb");
mkdirSync(fixDir, { recursive: true });

const goodMd = `# Example

Some prose.

<!-- BEGIN-CANONICAL: example_formula -->
x = sha256(canonical_json({a, b, c}))
<!-- END-CANONICAL: example_formula -->

More prose.
`;
const goodPath = join(fixDir, "good.md");
writeFileSync(goodPath, goodMd);

const parsed = parseCanonicalBlocks(goodMd);
check("good.md: zero parse errors", parsed.errors.length === 0);
check("good.md: one block parsed", parsed.blocks.length === 1);
check(
  "good.md: block name matches",
  parsed.blocks[0]?.name === "example_formula",
);
check(
  "good.md: block content matches",
  parsed.blocks[0]?.content === "x = sha256(canonical_json({a, b, c}))",
);
const goodSha = parsed.blocks[0]?.sha256;
check(
  "good.md: sha256 stable across two parses",
  goodSha === parseCanonicalBlocks(goodMd).blocks[0].sha256,
);

// extractCanonical works
const extracted = extractCanonical(goodPath, "example_formula");
check(
  "extractCanonical: returns inner content",
  extracted === "x = sha256(canonical_json({a, b, c}))",
);

// extractCanonical missing-name throws
let threwMissing = false;
try {
  extractCanonical(goodPath, "no_such_block");
} catch {
  threwMissing = true;
}
check("extractCanonical: throws on missing name", threwMissing);

// ---------------------------------------------------------------------------
// FIXTURE 2: deletion detection via allowlist diff.
// ---------------------------------------------------------------------------
const allowlist = {
  schema: "canonical-allowlist/v1",
  blocks: {
    example_formula: {
      sha256: goodSha,
      file: "kb/good.md",
      consumers: ["test/example.test.mjs"],
      rationale: "fixture",
    },
  },
};

let scan = scanTree(tmp);
let { index } = buildIndex(scan);
let findings = diffAgainstAllowlist(index, allowlist, tmp);
check(
  "FIXTURE 2a: clean diff has no ERROR findings",
  findings.filter((f) => f.severity === "ERROR").length === 0,
);

// Now MUTATE the block.
const mutatedMd = goodMd.replace(
  "x = sha256(canonical_json({a, b, c}))",
  "x = sha256(canonical_json({a, b, c, d}))",
);
writeFileSync(goodPath, mutatedMd);
scan = scanTree(tmp);
({ index } = buildIndex(scan));
findings = diffAgainstAllowlist(index, allowlist, tmp);
const mutatedFinding = findings.find(
  (f) => f.kind === "mutated_block" && f.name === "example_formula",
);
check(
  "FIXTURE 2b: mutated block flagged ERROR",
  mutatedFinding && mutatedFinding.severity === "ERROR",
);

// DELETE the file entirely (deletion of canonical block).
rmSync(goodPath);
scan = scanTree(tmp);
({ index } = buildIndex(scan));
findings = diffAgainstAllowlist(index, allowlist, tmp);
const deletedFinding = findings.find(
  (f) => f.kind === "deleted_block" && f.name === "example_formula",
);
check(
  "FIXTURE 2c: deleted block flagged ERROR",
  deletedFinding && deletedFinding.severity === "ERROR",
);

// Restore good.md for fixture 3.
writeFileSync(goodPath, goodMd);

// ---------------------------------------------------------------------------
// FIXTURE 3: structural errors (unclosed begin, name mismatch, duplicate).
// ---------------------------------------------------------------------------
const unclosed = `<!-- BEGIN-CANONICAL: unclosed_block -->
content
`;
const unclosedRes = parseCanonicalBlocks(unclosed);
check(
  "FIXTURE 3a: unclosed BEGIN raises error",
  unclosedRes.errors.some((e) => e.kind === "unclosed_begin"),
);

const mismatched = `<!-- BEGIN-CANONICAL: alpha -->
body
<!-- END-CANONICAL: beta -->
`;
const mismatchedRes = parseCanonicalBlocks(mismatched);
check(
  "FIXTURE 3b: name mismatch raises error",
  mismatchedRes.errors.some((e) => e.kind === "name_mismatch"),
);

const orphanEnd = `<!-- END-CANONICAL: ghost -->
`;
const orphanRes = parseCanonicalBlocks(orphanEnd);
check(
  "FIXTURE 3c: orphan END raises error",
  orphanRes.errors.some((e) => e.kind === "unbalanced_end"),
);

// Duplicate names across files.
const dupDir = join(tmp, "dup");
mkdirSync(dupDir, { recursive: true });
writeFileSync(
  join(dupDir, "a.md"),
  `<!-- BEGIN-CANONICAL: dup_name -->\nA\n<!-- END-CANONICAL: dup_name -->\n`,
);
writeFileSync(
  join(dupDir, "b.md"),
  `<!-- BEGIN-CANONICAL: dup_name -->\nB\n<!-- END-CANONICAL: dup_name -->\n`,
);
const dupScan = scanTree(dupDir);
const dupIndex = buildIndex(dupScan);
check(
  "FIXTURE 3d: duplicate name across files raises ERROR",
  dupIndex.findings.some((f) => f.kind === "duplicate_name"),
);

// ---------------------------------------------------------------------------
// FIXTURE 4: LIVE invariant against memory-system/kb/.
// Every canonical block in kb/ MUST be on the allowlist with matching sha.
// This is the regression that locks the source_msg_id_formula application.
// ---------------------------------------------------------------------------
const repoRoot = REPO_ROOT;
const repoAllowlistPath = join(repoRoot, "mcp/policy/canonical-allowlist.json");

if (existsSync(repoAllowlistPath)) {
  const repoAllowlist = JSON.parse(readFileSync(repoAllowlistPath, "utf8"));
  const repoScan = scanTree(repoRoot);
  const repoBuild = buildIndex(repoScan);
  const repoIndex = repoBuild.index;
  const repoFindings = diffAgainstAllowlist(repoIndex, repoAllowlist, repoRoot);

  check(
    "LIVE: no structural errors in kb/",
    repoBuild.findings.filter((f) => f.severity === "ERROR").length === 0,
    JSON.stringify(repoBuild.findings.filter((f) => f.severity === "ERROR")),
  );
  check(
    "LIVE: no MUTATED or DELETED blocks vs allowlist",
    repoFindings.filter((f) => f.severity === "ERROR").length === 0,
    JSON.stringify(repoFindings.filter((f) => f.severity === "ERROR")),
  );
  // Specifically: source_msg_id_formula must be present.
  check(
    "LIVE: source_msg_id_formula block present in kb/",
    repoIndex["source_msg_id_formula"] != null,
  );

  // ---------------------------------------------------------------------------
  // R35 M2: universal coverage. The pre-R35 floor protected ONE block
  // (source_msg_id_formula in build-plan.md). After R35 the foundation is
  // universal: every machine-consumed KB region in the inventory below MUST
  // exist as a CANONICAL block on the allowlist. New machine-consumed regions
  // must be added here AND to the allowlist in the SAME edit — that is the
  // discipline this assertion enforces.
  // ---------------------------------------------------------------------------
  const R36_REQUIRED_BLOCKS = [
    "source_msg_id_formula",
    "source_msg_id_inline_formula",
    "watermark_state_schema_v1",
    "policy_event_kinds_table",
    "health_envelope_schema_v1",
    // R36 GAP-S1 additions: Phase-3 recall KB canonical coverage.
    "phase3_v0_index_entry_shape",
    "phase3_v0_score_components_shape",
    "phase3_v0_recall_ledger_event_shape",
    "phase3_v0_predicate_snapshot_shape",
    "phase3_v1_recall_ledger_event_additions",
    "phase3_v1_test_plan",
  ];
  for (const name of R36_REQUIRED_BLOCKS) {
    check(
      `R36 LIVE: required canonical block '${name}' present in kb/`,
      repoIndex[name] != null,
      `missing from index keys=${JSON.stringify(Object.keys(repoIndex))}`,
    );
    check(
      `R36 LIVE: required canonical block '${name}' allowlisted with matching sha256`,
      repoAllowlist?.blocks?.[name]?.sha256 != null &&
        repoAllowlist.blocks[name].sha256 === repoIndex[name]?.sha256,
      `allow.sha=${repoAllowlist?.blocks?.[name]?.sha256} idx.sha=${repoIndex[name]?.sha256}`,
    );
  }

  // R35 M2 self-test: structural delete-detection across multiple blocks in
  // ONE markdown file. Build a synthetic kb/ with three blocks; mutate one;
  // assert diff flags only that one (no spurious flags on the other two).
  const multiTmp = mkdtempSync(join(tmpdir(), "r35-m2-multi-"));
  const multiKb = join(multiTmp, "kb");
  mkdirSync(multiKb, { recursive: true });
  const multiMd = `# Multi
<!-- BEGIN-CANONICAL: r35_block_alpha -->
alpha-content
<!-- END-CANONICAL: r35_block_alpha -->

prose

<!-- BEGIN-CANONICAL: r35_block_beta -->
beta-content
<!-- END-CANONICAL: r35_block_beta -->

<!-- BEGIN-CANONICAL: r35_block_gamma -->
gamma-content
<!-- END-CANONICAL: r35_block_gamma -->
`;
  const multiPath = join(multiKb, "multi.md");
  writeFileSync(multiPath, multiMd);
  const multiScan0 = scanTree(multiTmp);
  const { index: multiIndex0 } = buildIndex(multiScan0);
  const multiAllowlist = {
    schema: "canonical-allowlist/v1",
    blocks: {
      r35_block_alpha: {
        sha256: multiIndex0.r35_block_alpha.sha256,
        file: "kb/multi.md",
        consumers: [],
        rationale: "fixture",
      },
      r35_block_beta: {
        sha256: multiIndex0.r35_block_beta.sha256,
        file: "kb/multi.md",
        consumers: [],
        rationale: "fixture",
      },
      r35_block_gamma: {
        sha256: multiIndex0.r35_block_gamma.sha256,
        file: "kb/multi.md",
        consumers: [],
        rationale: "fixture",
      },
    },
  };
  // Mutate only beta.
  writeFileSync(
    multiPath,
    multiMd.replace("beta-content", "beta-content-MUTATED"),
  );
  const multiScan1 = scanTree(multiTmp);
  const { index: multiIndex1 } = buildIndex(multiScan1);
  const multiFindings = diffAgainstAllowlist(
    multiIndex1,
    multiAllowlist,
    multiTmp,
  );
  const mutatedNames = multiFindings
    .filter((f) => f.kind === "mutated_block")
    .map((f) => f.name)
    .sort();
  check(
    "R35 M2 SELFTEST: only the mutated block is flagged across multi-block file",
    JSON.stringify(mutatedNames) === JSON.stringify(["r35_block_beta"]),
    `got=${JSON.stringify(mutatedNames)}`,
  );
  try {
    rmSync(multiTmp, { recursive: true, force: true });
  } catch {}
}

// ---------------------------------------------------------------------------
// FIXTURE 6 (e10): the scanner must not descend into SCRATCH ROOTS.
//
// WHAT WENT WRONG. `.claude/worktrees/<id>/` holds Claude Code workflow
// worktrees — FULL COPIES of this repo, gitignored at .gitignore:62. scanTree
// descended into them, so every canonical block in the repo was also found in
// each copy and buildIndex reported them as `duplicate_name` ERRORs. Measured
// on the live tree with five sibling worktrees present: 75 ERROR findings,
// zero of which described anything wrong with the repo. One of them named
// kb/build-plan.md — the file the whole canonical-block apparatus exists to
// protect — as the offender, because a scratch copy happened to be indexed
// first. The harness was injuring itself and blaming the source.
//
// TWO ARMS, AND WHICH ONE IS LOAD-BEARING:
//
//   (A) HERMETIC + NON-VACUOUS. A mkdtemp root with kb/a.md and
//       .claude/worktrees/w1/kb/a.md carrying the SAME canonical name. The
//       fixture MANUFACTURES the collision, so this arm fails against the
//       unfixed scanner on any machine, with no worktrees required. This is
//       the arm that actually pins the behavior.
//
//   (B) LIVE PROPERTY. No `file` returned by scanTree(repoRoot) may contain a
//       scratch segment. This is the "a scanner reached into a scratch root"
//       gate, but it is VACUOUS when no worktree happens to exist on the
//       machine — which is exactly why (A) exists and why (B) is not trusted
//       alone.
//
// RED-RUN RECORD (2026-08-20, this workspace — verified against the pre-fix
// scanTree body, which read:
//     if (e.name.startsWith(".") && ...) { if (SKIP_DIRS.has(e.name)) continue; }
//     if (SKIP_DIRS.has(e.name)) continue;
// i.e. a hidden-dir branch byte-identical to the check after it, skipping
// nothing):
//
//   scanner under test: canonical-block-scan-PREFIX.mjs
//     files scanned  = 2
//     ERROR findings = 1
//     [{"severity":"ERROR","kind":"duplicate_name","file":"<tmp>/kb/a.md",
//       "name":"e10_scratch_probe","line":1,
//       "detail":"also defined in <tmp>/.claude/worktrees/w1/kb/a.md"}]
//     indexed file   = <tmp>/.claude/worktrees/w1/kb/a.md
//
// Read the last two lines together: the ERROR is filed against the REAL
// kb/a.md, and the block the index binds to is the SCRATCH COPY. Pre-fix, the
// scratch tree won and the repo was the defect. Post-fix, the same fixture
// gives `files scanned = 1`, `ERROR findings = 0`, `indexed file = <tmp>/kb/a.md`.
// ---------------------------------------------------------------------------
{
  const scratchTmp = mkdtempSync(join(tmpdir(), "e10-scratch-"));
  const realKb = join(scratchTmp, "kb");
  const worktreeKb = join(
    scratchTmp,
    ".claude",
    "worktrees",
    "w1",
    "kb",
  );
  mkdirSync(realKb, { recursive: true });
  mkdirSync(worktreeKb, { recursive: true });
  const collidingMd =
    `<!-- BEGIN-CANONICAL: e10_scratch_probe -->\n` +
    `payload\n` +
    `<!-- END-CANONICAL: e10_scratch_probe -->\n`;
  const realPath = join(realKb, "a.md");
  writeFileSync(realPath, collidingMd);
  writeFileSync(join(worktreeKb, "a.md"), collidingMd);

  const scratchScan = scanTree(scratchTmp);
  const scratchBuild = buildIndex(scratchScan);
  const scratchErrors = scratchBuild.findings.filter(
    (f) => f.severity === "ERROR",
  );

  check(
    "e10 FIXTURE 6a: scratch-root copy does not collide with the real kb/ block",
    scratchErrors.length === 0,
    `findings=${JSON.stringify(scratchErrors)}`,
  );
  check(
    "e10 FIXTURE 6a: the indexed block is the kb/ file, not the scratch copy",
    scratchBuild.index["e10_scratch_probe"]?.file === realPath,
    `got=${scratchBuild.index["e10_scratch_probe"]?.file} want=${realPath}`,
  );
  check(
    "e10 FIXTURE 6a: no scanned file lives under a scratch root",
    scratchScan.every((s) => !containsScratchSegment(s.file)),
    `scratch-rooted files=${JSON.stringify(
      scratchScan.map((s) => s.file).filter((f) => containsScratchSegment(f)),
    )}`,
  );

  // Injectability: the exclusion predicate is an opts seam, so a caller can
  // widen or narrow it without a second copy of the rule living anywhere.
  const scanNoSkip = scanTree(scratchTmp, { skipDirNames: () => false });
  check(
    "e10 FIXTURE 6a: skipDirNames override is honored (non-vacuity control)",
    scanNoSkip.length === scratchScan.length + 1,
    `with-skip=${scratchScan.length} without-skip=${scanNoSkip.length} — if these ` +
      "are equal the fixture never planted a reachable scratch file and 6a proves nothing",
  );

  try {
    rmSync(scratchTmp, { recursive: true, force: true });
  } catch {}

  // (B) LIVE property assertion. Vacuous when the machine has no worktrees;
  // the count is printed either way so a reader can see whether it bit.
  const liveScan = scanTree(repoRoot);
  const liveScratchFiles = liveScan
    .map((s) => s.file)
    .filter((f) => containsScratchSegment(f));
  check(
    "e10 FIXTURE 6b LIVE: scanTree(repoRoot) returns no file under a scratch root",
    liveScratchFiles.length === 0,
    `scratch-rooted files=${JSON.stringify(liveScratchFiles.slice(0, 10))} (total ${liveScratchFiles.length})`,
  );
}

// ---------------------------------------------------------------------------
// Cleanup + exit discipline.
// ---------------------------------------------------------------------------
try {
  rmSync(tmp, { recursive: true, force: true });
} catch {}

console.log(`canonical-block-integrity: ${pass} pass, ${fail} fail`);
if (fail > 0) {
  console.error(
    `FAIL DETAIL: ${JSON.stringify(failures, null, 2)}`,
  );
  process.exit(1);
}
process.exit(0);
