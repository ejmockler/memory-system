// no-legacy-pipeline-references.test.mjs
//
// R32 prevent-legacy regression test (Lesson 55).
//
// R34 B8 (semantic-content scanner) extension: the line-scan already
// detects forbidden identifiers inside string literals because
// `stripComments` strips comments only (not strings). The B8 layer
// formalises this with named self-test assertions (8), (9), and (10):
//   (8) string-literal in a test-fixture .test.mjs file is flagged
//       (single-quoted, double-quoted, template-literal, JSON-embedded)
//   (9) comment-only reference inside a test file remains stripped
//   (10) every R33-surviving forbidden identifier is registered on the
//        canonical list (regression guard against accidental deletion)
// This closes ROOT-CAUSE-1 from R34: B3 catches orphan IMPORTS, B4
// catches forbidden IDENTIFIERS in production files; neither caught the
// 14 dead-concept-name LITERAL STRINGS in test fixtures. B8 makes that
// scan layer explicit and self-tested.
//
// Scans the workspace for any of the forbidden legacy identifiers listed in
// `mcp/lib/forbidden-legacy-identifiers.js`. Fails if any forbidden identifier
// appears in production scan paths after R32's removal landed.
//
// Scan paths (relative to the checkout root):
//   - mcp/        (excluding this test file + mcp/lib/forbidden-legacy-identifiers.js)
//                 R33 B4: mcp/test/** is EXPLICITLY in scope. The whole `mcp/`
//                 root is walked, so mcp/test/** falls under it. The R32.1
//                 brutalist round surfaced 50 surviving test-file hits
//                 (tests importing tickOnce, declaring QUEUE_DIR, asserting
//                 on policy.distillation.batch.* events). The R33 B4
//                 directive: tests-of-deleted-code are themselves drift.
//                 Excluded only: THIS file (which references identifiers by
//                 definition) + kb/legacy-archive.md +
//                 kb/deprecation-discipline.md +
//                 mcp/lib/forbidden-legacy-identifiers.js (the list itself)
//                 + scripts/spec-sweep.mjs (the gate that imports the list).
//   - daemons/
//   - scripts/
//   - kb/         (R32.1: live operator docs are in scope; meta-docs excluded)
//   - package.json (top-level repo file)
//
// Scanned file extensions: .js, .mjs, .cjs, .json, .sh, .md (.md added R32.1).
//
// Excluded paths (forbidden identifiers may appear here legitimately):
//   - kb/legacy-archive.md             (the operator-curated history record)
//   - kb/deprecation-discipline.md     (the policy that names the names)
//   - mcp/lib/forbidden-legacy-identifiers.js  (the list itself)
//   - mcp/test/no-legacy-pipeline-references.test.mjs  (this file)
//   - scripts/spec-sweep.mjs           (the gate that imports the list)
//   - reviews/, .git/, node_modules/, vendor/, dist/, build/, /tmp/
//
// Boundary semantics:
//   - `tickOnce` must match `tickOnce` but NOT `tickSourcesOnce`. The
//     bounded regex in forbidden-legacy-identifiers.js uses a lookaround
//     boundary that treats `_`, `.`, `-`, `0-9`, `A-Za-z` as identifier
//     characters. The two self-test assertions at the bottom of this file
//     verify both the positive and negative cases.
//   - `policy.distillation.batch.failed` matches its full literal form;
//     bare `failed` is not on the list.
//
// Run: node test/no-legacy-pipeline-references.test.mjs
//
// Exit 0 if zero forbidden identifiers in non-excluded paths. Exit 1
// otherwise. Self-test failures also exit 1.
//
// Wired into `npm test` at the end of the chain per package.json.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  FORBIDDEN_IDENTIFIERS,
  EXCLUDED_PATH_SUFFIXES,
  EXCLUDED_PATH_SEGMENTS,
  defaultScanRoots,
  stripComments,
  scanLineForForbidden,
  isExcludedPath,
  isScannedFile,
} from "../lib/forbidden-legacy-identifiers.js";

const THIS_FILE = fileURLToPath(import.meta.url);
const MEMORY_SYSTEM_ROOT = resolve(dirname(THIS_FILE), "..", "..");
// Resolves to the checkout root (two levels above this file).

// ---------- helpers ----------------------------------------------------------

function relPath(absPath) {
  return relative(MEMORY_SYSTEM_ROOT, absPath).split("\\").join("/");
}

function extOf(path) {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "";
  return path.slice(dot).toLowerCase();
}

// Recursive directory walk that yields absolute file paths matching the
// scanner's extension list and not falling under an excluded segment.
function* walk(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const p = join(root, ent.name);
    const rel = relPath(p);
    if (isExcludedPath(rel)) continue;
    if (ent.isDirectory()) {
      yield* walk(p);
    } else if (ent.isFile()) {
      if (isScannedFile(rel)) yield p;
    }
  }
}

// Scan a single file. Returns array of `{ path, lineNo, line, hits }`.
function scanFile(absPath) {
  let body;
  try {
    body = readFileSync(absPath, "utf8");
  } catch {
    return [];
  }
  const ext = extOf(absPath);
  const lines = body.split("\n");
  const fileHits = [];
  // Track block-comment state across lines.
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (inBlockComment) {
      const close = line.indexOf("*/");
      if (close < 0) continue;
      line = line.slice(close + 2);
      inBlockComment = false;
    }
    // Detect unterminated block-comment opening on THIS line.
    const openIdx = line.lastIndexOf("/*");
    const closeIdx = line.lastIndexOf("*/");
    if (openIdx >= 0 && (closeIdx < 0 || closeIdx < openIdx)) {
      inBlockComment = true;
      line = line.slice(0, openIdx);
    }
    const stripped = stripComments(line, ext);
    const hits = scanLineForForbidden(stripped);
    if (hits.length > 0) {
      fileHits.push({ path: absPath, lineNo: i + 1, line: line, hits });
    }
  }
  return fileHits;
}

// scanRoots - walks each provided root (file or directory) and returns the
// flattened hit list, EXCLUDING any path in the excluded list.
export function scanForLegacyHits(rootsAbs) {
  const allHits = [];
  for (const root of rootsAbs) {
    let st;
    try {
      st = statSync(root);
    } catch {
      continue;
    }
    if (st.isFile()) {
      const rel = relPath(root);
      if (!isScannedFile(rel)) continue;
      if (isExcludedPath(rel)) continue;
      allHits.push(...scanFile(root));
    } else if (st.isDirectory()) {
      for (const file of walk(root)) {
        const rel = relPath(file);
        if (isExcludedPath(rel)) continue;
        allHits.push(...scanFile(file));
      }
    }
  }
  return allHits;
}

// ---------- self-test --------------------------------------------------------
//
// Two assertions are required by the round directive:
//   (1) the scanner CAN detect a fake forbidden identifier in a fixture file
//   (2) the scanner does NOT match `tickSourcesOnce` against the `tickOnce`
//       pattern (boundary correctness)
//
// R32.1 added more assertions to close the gaps the R32 brutalist round
// found:
//   (3) the scanner SKIPS lines marked as `// comment-only` references
//   (4) the scanner SKIPS files at excluded paths
//   (5) a NEW forbidden identifier `distillation-state` is detected (the
//       silent corpse-read in mcp/lib/tools/health.js the R32 sweep missed)
//   (6) the scanner reads `.md` files and FLAGS forbidden identifiers in
//       live kb prose (the R32 KB-drift gap). The two allow-listed kb
//       meta-docs (kb/legacy-archive.md, kb/deprecation-discipline.md) are
//       still excluded.

function runSelfTest() {
  const dir = mkdtempSync(join(tmpdir(), "prevent-legacy-self-test-"));
  try {
    // Fixture 1: drift file with a forbidden identifier in code.
    const driftPath = join(dir, "drift.js");
    writeFileSync(driftPath, 'const x = "distillation-supervisor";\nconst y = tickOnce;\n');

    // Fixture 2: a legitimate-looking identifier that MUST NOT match.
    const okPath = join(dir, "ok.js");
    writeFileSync(okPath, "await tickSourcesOnce({ now: undefined });\n");

    // Fixture 3: forbidden identifier ONLY in a // comment - should be skipped.
    const commentOnlyPath = join(dir, "comment-only.js");
    writeFileSync(commentOnlyPath, "const z = 1; // refers to distillation-supervisor in prose\n");

    // Fixture 4: forbidden identifier in a fixture at an EXCLUDED suffix path.
    const excludedDir = join(dir, "kb");
    mkdirSync(excludedDir, { recursive: true });
    const excludedPath = join(excludedDir, "legacy-archive.md");
    writeFileSync(excludedPath, "distillation-supervisor was retired in R32.\n");

    // Fixture 5: NEW R32.1 forbidden identifier `distillation-state`. The
    // R32 sweep silently let `health.js` read policy/distillation-state.json
    // because the literal `distillation-state` was not on the list.
    const stateDriftPath = join(dir, "state-drift.js");
    writeFileSync(
      stateDriftPath,
      'const p = path.join(root, "policy", "distillation-state.json");\n',
    );

    // Fixture 6: a live-kb-style .md doc containing a normative reference
    // to `tickOnce`. R32.1 added `.md` to SCANNED_EXTENSIONS so this MUST
    // be flagged. The fixture lives at a plain `drift.md` name; the
    // exclude check is suffix-based on the allow-listed kb files, so a
    // generic `drift.md` should NOT match the suffix list.
    const mdDriftPath = join(dir, "drift.md");
    writeFileSync(
      mdDriftPath,
      "# Cascade pipeline\n\nThe daemon runs `tickOnce()` every 60s to drain the queue.\n",
    );

    // The scan API takes ABSOLUTE roots and the EXCLUDED check uses relpaths
    // anchored at MEMORY_SYSTEM_ROOT. The fixture lives in /tmp, so
    // EXCLUDED_PATH_SUFFIXES (kb/legacy-archive.md) will not match unless the
    // fixture relpath ends with that suffix. To exercise excluded-path
    // skipping we add the fixture absolute path to a tmp-scoped excluded list.

    // ---- (1) scanner detects drift ----
    const driftHits = scanFile(driftPath);
    assert.ok(driftHits.length >= 1, "(1) drift.js: expected at least one hit");
    const allIds = driftHits.flatMap((h) => h.hits.map((x) => x.id));
    assert.ok(
      allIds.includes("distillation-supervisor"),
      "(1) drift.js: expected distillation-supervisor hit, got " + JSON.stringify(allIds),
    );
    assert.ok(
      allIds.includes("tickOnce"),
      "(1) drift.js: expected tickOnce hit, got " + JSON.stringify(allIds),
    );

    // ---- (2) tickSourcesOnce MUST NOT match tickOnce ----
    const okHits = scanFile(okPath);
    const okIds = okHits.flatMap((h) => h.hits.map((x) => x.id));
    assert.deepEqual(
      okIds,
      [],
      "(2) ok.js: tickSourcesOnce must not match tickOnce, got " + JSON.stringify(okIds),
    );

    // ---- (3) comment-only reference is stripped ----
    const commentHits = scanFile(commentOnlyPath);
    assert.deepEqual(
      commentHits,
      [],
      "(3) comment-only.js: identifier only in // comment must be stripped, got "
        + JSON.stringify(commentHits),
    );

    // ---- (4) excluded path is skipped ----
    // Direct check on isExcludedPath against the well-known suffix.
    assert.equal(
      isExcludedPath("kb/legacy-archive.md"),
      true,
      "(4) isExcludedPath: kb/legacy-archive.md must be excluded",
    );
    assert.equal(
      isExcludedPath("kb/deprecation-discipline.md"),
      true,
      "(4) isExcludedPath: kb/deprecation-discipline.md must be excluded",
    );
    assert.equal(
      isExcludedPath("mcp/lib/forbidden-legacy-identifiers.js"),
      true,
      "(4) isExcludedPath: forbidden-legacy-identifiers.js (the list itself) must be excluded",
    );
    assert.equal(
      isExcludedPath("mcp/test/no-legacy-pipeline-references.test.mjs"),
      true,
      "(4) isExcludedPath: the regression test must be excluded",
    );
    assert.equal(
      isExcludedPath("scripts/spec-sweep.mjs"),
      true,
      "(4) isExcludedPath: spec-sweep.mjs (the gate that imports the list) must be excluded",
    );
    assert.equal(
      isExcludedPath("mcp/lib/policy-events.js"),
      false,
      "(4) isExcludedPath: production lib code is NOT excluded",
    );
    // Reviews dir is segment-excluded regardless of suffix.
    assert.equal(
      isExcludedPath("reviews/r32/audit-pipeline.md"),
      true,
      "(4) isExcludedPath: reviews/ segment must be excluded",
    );

    // ---- (5) R32.1 new forbidden id: `distillation-state` ----
    // The fixture uses the production drift signature: a `path.join` to
    // `policy/distillation-state.json`. Because the bounded-regex treats
    // `.` as an identifier character, the bare `distillation-state` token
    // does NOT match when followed by `.json`. The R32.1 list therefore
    // registers BOTH the bare token AND the explicit `.json` form; the
    // production drift hit is the `.json` form.
    const stateHits = scanFile(stateDriftPath);
    const stateIds = stateHits.flatMap((h) => h.hits.map((x) => x.id));
    assert.ok(
      stateIds.includes("distillation-state.json"),
      "(5) state-drift.js: expected distillation-state.json hit, got " + JSON.stringify(stateIds),
    );
    // Confirm both identifiers are registered in the canonical list so
    // spec-sweep (which imports the same list) inherits the gate.
    const registeredIds = FORBIDDEN_IDENTIFIERS.map((x) => x.id);
    assert.ok(
      registeredIds.includes("distillation-state"),
      "(5) FORBIDDEN_IDENTIFIERS: distillation-state (bare token) must be on the list",
    );
    assert.ok(
      registeredIds.includes("distillation-state.json"),
      "(5) FORBIDDEN_IDENTIFIERS: distillation-state.json (filename form) must be on the list",
    );
    // Bare-token form must ALSO catch a non-.json reference (e.g. var name,
    // kb prose). Fixture 5b: plain identifier.
    const stateBareDriftPath = join(dir, "state-bare-drift.md");
    writeFileSync(
      stateBareDriftPath,
      "The legacy `distillation-state` field used to ride in the health envelope.\n",
    );
    const bareHits = scanFile(stateBareDriftPath);
    const bareIds = bareHits.flatMap((h) => h.hits.map((x) => x.id));
    assert.ok(
      bareIds.includes("distillation-state"),
      "(5) state-bare-drift.md: expected bare distillation-state hit, got " + JSON.stringify(bareIds),
    );

    // ---- (6) R32.1 .md extension: drift.md MUST be scanned and flagged ----
    // First: confirm the file would be picked up by the walker.
    assert.equal(
      isScannedFile("kb/architecture.md"),
      true,
      "(6) isScannedFile: .md files must be in scope after R32.1",
    );
    // Generic drift.md is not on the suffix allow-list, so it should be
    // scanned and flagged.
    assert.equal(
      isExcludedPath("kb/architecture.md"),
      false,
      "(6) isExcludedPath: live kb docs (not legacy-archive/deprecation-discipline) must NOT be excluded",
    );
    const mdHits = scanFile(mdDriftPath);
    const mdIds = mdHits.flatMap((h) => h.hits.map((x) => x.id));
    assert.ok(
      mdIds.includes("tickOnce"),
      "(6) drift.md: expected tickOnce hit in markdown body, got " + JSON.stringify(mdIds),
    );
    // The two allow-listed kb meta-docs MUST still be excluded.
    assert.equal(
      isExcludedPath("kb/legacy-archive.md"),
      true,
      "(6) isExcludedPath: kb/legacy-archive.md remains excluded after .md scoping",
    );
    assert.equal(
      isExcludedPath("kb/deprecation-discipline.md"),
      true,
      "(6) isExcludedPath: kb/deprecation-discipline.md remains excluded after .md scoping",
    );

    // ---- (7) R33 B4: mcp/test/** MUST be in scope ----
    // The 50 R32.1 surviving test-file hits (tickOnce imports, QUEUE_DIR
    // declarations, policy.distillation.batch.* references) are themselves
    // drift — tests-of-deleted-code. The scanner must walk mcp/test/**.
    // Sanity: defaultScanRoots returns mcp/ as a root, so any path under
    // mcp/test/** is visited. We confirm it via isExcludedPath: a typical
    // test file path must NOT be excluded.
    assert.equal(
      isExcludedPath("mcp/test/watermark-unit.test.mjs"),
      false,
      "(7) mcp/test/** must be in scope: a typical test file path is NOT excluded",
    );
    assert.equal(
      isExcludedPath("mcp/test/daemons/watermark-multisource.test.mjs"),
      false,
      "(7) mcp/test/** must be in scope: nested test paths are NOT excluded",
    );
    assert.equal(
      isExcludedPath("mcp/test/ingest/stage0-modules.test.mjs"),
      false,
      "(7) mcp/test/** must be in scope: tests under nested dirs are NOT excluded",
    );
    // Confirm `mcp/` is the walked root that covers `mcp/test/**`.
    const sampleRoots = defaultScanRoots("/tmp/anywhere");
    assert.ok(
      sampleRoots.some((r) => r === "/tmp/anywhere/mcp"),
      "(7) defaultScanRoots: `mcp/` must be a scan root so mcp/test/** is covered, got "
        + JSON.stringify(sampleRoots),
    );

    // ---- (8) R34 B8: SEMANTIC-CONTENT scan of string-literal layer ----
    // The R33 surviving 14 hits were all dead-concept-name LITERAL STRINGS
    // inside test fixture .test.mjs files, e.g.:
    //   const QUEUE_DIR = join(STORAGE_DIR, "distillation-queue");
    // B3 (import-graph orphan scan) returns 0 because these are strings not
    // imports. The R32 production-file legacy scan stripped strings (via
    // stripComments + scanLineForForbidden). The existing line-scan does NOT
    // strip strings — it scans the full line including string contents — so
    // the 14 hits surface. B8 formalises this as a NAMED scan layer with
    // dedicated self-tests so a future regression (e.g. someone deciding to
    // strip strings to silence noise) is caught by an explicit assertion.
    //
    // The string-literal layer also catches identifiers that appear ONLY
    // inside a string and would be invisible to a bare-token regex if strings
    // were stripped.
    const fixtureTestPath = join(dir, "fixture-with-literal.test.mjs");
    writeFileSync(
      fixtureTestPath,
      [
        "import { ok } from 'node:assert';",
        "const QUEUE_DIR = join(STORAGE_DIR, \"distillation-queue\");",
        "ok(QUEUE_DIR);",
        "",
      ].join("\n"),
    );
    const fixtureLitHits = scanFile(fixtureTestPath);
    const fixtureLitIds = fixtureLitHits.flatMap((h) => h.hits.map((x) => x.id));
    assert.ok(
      fixtureLitIds.includes("distillation-queue"),
      "(8) B8 semantic-content: string-literal in test fixture MUST be flagged, got "
        + JSON.stringify(fixtureLitIds),
    );

    // Sub-assertion: a template-literal also flags.
    const fixtureTplPath = join(dir, "fixture-template.test.mjs");
    writeFileSync(
      fixtureTplPath,
      [
        "const name = `distillation-supervisor`;",
        "",
      ].join("\n"),
    );
    const fixtureTplHits = scanFile(fixtureTplPath);
    const fixtureTplIds = fixtureTplHits.flatMap((h) => h.hits.map((x) => x.id));
    assert.ok(
      fixtureTplIds.includes("distillation-supervisor"),
      "(8) B8 semantic-content: template-literal string MUST be flagged, got "
        + JSON.stringify(fixtureTplIds),
    );

    // Sub-assertion: single-quoted string in a JSON-style fixture flags.
    const fixtureJsonPath = join(dir, "fixture.json");
    writeFileSync(
      fixtureJsonPath,
      '{ "kind": "policy.distillation.batch.enqueued", "n": 1 }\n',
    );
    const fixtureJsonHits = scanFile(fixtureJsonPath);
    const fixtureJsonIds = fixtureJsonHits.flatMap((h) => h.hits.map((x) => x.id));
    assert.ok(
      fixtureJsonIds.includes("policy.distillation.batch.enqueued"),
      "(8) B8 semantic-content: JSON string literal MUST be flagged, got "
        + JSON.stringify(fixtureJsonIds),
    );

    // ---- (9) R34 B8: comment-only reference in test file remains stripped ---
    // Symmetry guard: B8 must NOT regress the (3) comment-only stripping.
    // A test file with a forbidden identifier ONLY in a `// comment` is
    // still legitimate prose drift (handled by spec-sweep KB pass) and the
    // line-scan must continue to strip it.
    const fixtureCommentOnlyPath = join(dir, "fixture-comment.test.mjs");
    writeFileSync(
      fixtureCommentOnlyPath,
      [
        "// historical note: distillation-queue was the R25-era claim ring",
        "const z = 1;",
        "",
      ].join("\n"),
    );
    const fixtureCommentHits = scanFile(fixtureCommentOnlyPath);
    assert.deepEqual(
      fixtureCommentHits,
      [],
      "(9) B8 semantic-content: comment-only reference in test file MUST remain stripped, got "
        + JSON.stringify(fixtureCommentHits),
    );

    // ---- (10) R34 B8: ALL R33 forbidden-list extension identifiers present -
    // The B8 directive enumerates five identifiers the R33 hits were drawn
    // from. Confirm each is registered so the unified scan covers them.
    const r33SemanticIds = [
      "distillation-queue",
      "distillation-state.json",
      "distillation-supervisor",
      "tickOnce",
      "policy.distillation.batch.enqueued",
      "policy.distillation.batch.failed",
      "policy.distillation.batch.poisoned",
    ];
    const registeredIds10 = FORBIDDEN_IDENTIFIERS.map((x) => x.id);
    for (const wanted of r33SemanticIds) {
      assert.ok(
        registeredIds10.includes(wanted),
        "(10) B8 semantic-content: forbidden id `" + wanted
          + "` MUST be on the canonical list, registered ids = "
          + JSON.stringify(registeredIds10),
      );
    }

    process.stdout.write("self-test: PASS (10 assertions)\n");
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// ---------- main -------------------------------------------------------------

function main() {
  // 1. Self-test first - if the scanner is broken, real hits are noise.
  runSelfTest();

  // 2. Real scan.
  const roots = defaultScanRoots(MEMORY_SYSTEM_ROOT);
  const hits = scanForLegacyHits(roots);

  if (hits.length === 0) {
    process.stdout.write("no-legacy-pipeline-references: PASS (0 hits)\n");
    process.stdout.write(
      `  forbidden identifiers checked: ${FORBIDDEN_IDENTIFIERS.length}\n`,
    );
    process.stdout.write(`  scan roots: ${roots.length}\n`);
    process.exit(0);
  }

  // Group hits by file for readability.
  const byFile = new Map();
  for (const h of hits) {
    if (!byFile.has(h.path)) byFile.set(h.path, []);
    byFile.get(h.path).push(h);
  }

  process.stderr.write(
    `\nno-legacy-pipeline-references: FAIL (${hits.length} hit${hits.length === 1 ? "" : "s"} across ${byFile.size} file${byFile.size === 1 ? "" : "s"})\n\n`,
  );
  for (const [file, fileHits] of byFile) {
    process.stderr.write(`  ${relPath(file)}:\n`);
    for (const h of fileHits) {
      const ids = h.hits.map((x) => x.id).join(", ");
      const ctx = h.line.trim().slice(0, 140);
      process.stderr.write(`    L${h.lineNo}  [${ids}]  ${ctx}\n`);
    }
  }
  process.stderr.write(
    "\n  Per kb/deprecation-discipline.md, the names above are forbidden in production code.\n",
  );
  // Allowed-locations list is DERIVED from EXCLUDED_PATH_SUFFIXES, never
  // restated. A hardcoded copy silently goes stale the moment the allowlist
  // grows (it did), printing an incomplete list to the operator at exactly the
  // moment they are deciding whether a hit is legitimate. Deriving it makes the
  // import load-bearing and closes the drift class instead of the instance.
  process.stderr.write("  Allowed locations: ");
  process.stderr.write(EXCLUDED_PATH_SUFFIXES.join(", "));
  process.stderr.write(".\n\n");
  process.exit(1);
}

main();
