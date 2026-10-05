// no-key-leakage-in-artifacts.test.mjs (R29.2 F-SCRUB regression)
//
// Purpose: Prevent live GEMINI API keys (AIza-format and AQ-format) from being
// committed into the workspace's tracked artifacts. The R29 brutalist findings
// included repeated near-misses where the legacy GEMINI_API_KEY (and AQ pool
// keys) leaked into docs/STATUS, review files, and plan artifacts.
//
// Scope (intentionally NARROW):
//   - kb/**/*.md                (canonical knowledge base markdown)
//   - mcp/lib/**/*.js           (production JS)
//   - mcp/test/**/*.mjs         (test sources; synthetic fixtures EXEMPT)
//   - <workspace-root>/*.md     (top-level docs: README.md, etc.)
//                               R29.3 expansion — R29.2 brutalist found a real
//                               key leaked in a top-level markdown file that
//                               the test missed.
//
// EXEMPT (operator data, not code/docs):
//   - *.plist files (LaunchAgent plists are the legitimate on-disk key store
//     per R29 brutalist decision; auth config, not source)
//   - daemon log files (stdout/stderr; runtime artifacts, not committed)
//   - node_modules, .git, anything matching gitignore
//
// Pattern (live keys only):
//   - AIza[A-Za-z0-9_-]{35}            (legacy Google API key, exactly 39 chars)
//   - AQ\.[A-Za-z0-9_-]{40,80}         (new Vertex/GenAI AQ.* format)
//
// Synthetic fixtures used in tests are EXEMPT via allow-list of substrings:
//   "FAKE", "JUNK", "TEST", "MOCK", "test_not_used", "AIzaXX", "AIzaFAKE",
//   "synthetic", "fixture", "REPLACE_WITH"
// If a hit contains any allow-list substring, it is NOT a leak.
//
// Run: node test/no-key-leakage-in-artifacts.test.mjs
// Exits 0 on PASS (zero leaks), non-zero on any leaked key bytes detected.

import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
// fileURLToPath, not URL.pathname: pathname stays percent-encoded, so a
// checkout path containing a space resolved to a directory that does not exist.
import { fileURLToPath } from "node:url";
import { join, relative, resolve } from "node:path";

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// Workspace root = parent of mcp/.
const TEST_FILE_DIR = fileURLToPath(new URL(".", import.meta.url));
const MCP_DIR = resolve(TEST_FILE_DIR, "..");
const WORKSPACE_ROOT = resolve(MCP_DIR, "..");

// Live-key patterns (strict shapes; do NOT match the 12-char redacted prefix).
const LIVE_KEY_PATTERNS = [
  /AIza[A-Za-z0-9_-]{35}/g, // legacy 39-char Google API key
  /AQ\.[A-Za-z0-9_-]{40,80}/g, // new AQ.* Vertex format (any body prefix)
];

// Substrings that mark a hit as a synthetic test fixture (case-insensitive).
const FIXTURE_ALLOWLIST = [
  "fake",
  "junk",
  "test_not_used",
  "aizaxx",
  "aizajunk",
  "synthetic",
  "fixture",
  "replace_with",
  "mock",
];

function isFixture(matchText, surroundingLine) {
  const haystack = (surroundingLine || matchText).toLowerCase();
  return FIXTURE_ALLOWLIST.some((needle) => haystack.includes(needle));
}

// Recursive directory walker. Skips node_modules + hidden dirs.
function walk(dir, fileFilter, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(full, fileFilter, out);
    } else if (ent.isFile() && fileFilter(full)) {
      out.push(full);
    }
  }
  return out;
}

// Build the file set per the three scope buckets.
const KB_DIR = join(WORKSPACE_ROOT, "kb");
const LIB_DIR = join(MCP_DIR, "lib");
const TEST_DIR = join(MCP_DIR, "test");

// R29.3 expansion: top-level workspace markdown files (README.md, etc.). Defensive try/catch — if WORKSPACE_ROOT shape changes (e.g. mcp/ is
// the repo root in some checkouts), readdirSync may surface unexpected entries.
function topLevelMarkdownFiles() {
  const hits = [];
  let entries;
  try {
    entries = readdirSync(WORKSPACE_ROOT, { withFileTypes: true });
  } catch {
    return hits;
  }
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!ent.name.endsWith(".md")) continue;
    const full = join(WORKSPACE_ROOT, ent.name);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    hits.push(full);
  }
  return hits;
}

const targetFiles = [
  ...walk(KB_DIR, (p) => p.endsWith(".md")),
  ...walk(LIB_DIR, (p) => p.endsWith(".js")),
  ...walk(TEST_DIR, (p) => p.endsWith(".mjs")),
  ...topLevelMarkdownFiles(),
];

// Also exclude THIS test file itself — it contains the regex patterns
// as source code, which would self-match.
const SELF = resolve(TEST_FILE_DIR, "no-key-leakage-in-artifacts.test.mjs");
const filteredTargets = targetFiles.filter((p) => p !== SELF);

check(
  "scan target set non-empty",
  filteredTargets.length > 0,
  `scanned 0 files; check kb/, mcp/lib/, mcp/test/ exist (workspace=${WORKSPACE_ROOT})`
);

const leaks = []; // { file, line, lineNum, match }
for (const file of filteredTargets) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  // Skip files that are huge binary blobs disguised as text (defensive).
  if (text.length > 2_000_000) continue;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const pattern of LIVE_KEY_PATTERNS) {
      // Reset pattern lastIndex (g flag is per-pattern stateful).
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(line)) !== null) {
        const matchText = m[0];
        if (isFixture(matchText, line)) continue;
        leaks.push({
          file: relative(WORKSPACE_ROOT, file),
          lineNum: i + 1,
          match: matchText.slice(0, 12) + "...", // redact in the failure report
        });
      }
    }
  }
}

check(
  "zero live-key leaks across kb/, mcp/lib/, mcp/test/",
  leaks.length === 0,
  leaks.length === 0
    ? ""
    : `${leaks.length} leak(s):\n` +
        leaks
          .map((l) => `  ${l.file}:${l.lineNum} → ${l.match}`)
          .join("\n")
);

// Coverage sanity: confirm we actually scanned representative files in each bucket.
const scannedKb = filteredTargets.some((p) => p.startsWith(KB_DIR));
const scannedLib = filteredTargets.some((p) => p.startsWith(LIB_DIR));
const scannedTest = filteredTargets.some((p) => p.startsWith(TEST_DIR));
// R29.3: assert the top-level *.md bucket actually picked up README.md — the
// top-level markdown bucket is the R29.2 leak class the original test missed.
const README_MD = join(WORKSPACE_ROOT, "README.md");
const scannedReadmeMd = filteredTargets.includes(README_MD);
check("kb/ bucket scanned", scannedKb);
check("mcp/lib/ bucket scanned", scannedLib);
check("mcp/test/ bucket scanned", scannedTest);
check("README.md scanned (R29.3 scope expansion)", scannedReadmeMd);

// ===========================================================================
// e10: NO LITERAL NUL BYTE IN ANY TRACKED FILE.
//
// WHY THIS SUITE. This file is already the repo's "no forbidden byte-pattern
// in tracked workspace files" gate: it owns the check()/failures harness, the
// dot-dir-skipping walker, and the discipline of asserting over bytes that a
// human reader cannot see. A NUL byte is the same shape of defect as a leaked
// key — content that is present on disk and absent from every casual view —
// so it belongs here rather than in a new suite. (It also HAS to live in an
// already-registered suite: run-all-tests.mjs runs suiteParityDrift over
// every mcp/test/**/*.test.mjs on disk against its SUITES literal with an
// EMPTY ANNOTATED_SKIP, and drift exits 2 BEFORE any suite runs. A new test
// file would red-gate the entire run until the runner was edited.)
//
// WHY THE KEY SCANNER ABOVE CANNOT DO THIS JOB. It reads with
// `readFileSync(file, "utf8")` and searches the resulting STRING. A 0x00 is a
// perfectly ordinary character in a JS string, so a NUL-bearing file sails
// through it — exactly as it sails through `grep` (which declares the file
// binary and prints no line) and `git diff` (which prints "Binary files
// differ"). The only way to see the byte is to read the BUFFER, which is what
// scanForNulBytes does.
//
// THREE ARMS:
//   (A) PLANTED NUL   — a temp file with a real 0x00 must produce exactly one
//                       finding at the right offset. This is the red-first
//                       proof that the guard FIRES; without it the live arm
//                       below is just a green light of unknown wiring.
//   (B) NEGATIVE CTRL — a NUL-free file must produce zero findings, so (A) is
//                       not passing because the scanner flags everything.
//   (C) LIVE          — the tracked set contains zero 0x00 bytes.
//
// RED-FIRST EVIDENCE (2026-08-20, this workspace): with scanForNulBytes
// stubbed to `() => ({ root, mode: "explicit", files_scanned: 1,
// findings: [] })` — i.e. the guard present but blind — arm (A) fails:
//
//   FAIL  e10 NUL-A: planted 0x00 produces exactly one finding
//         — got 0 finding(s): []
//   FAIL  e10 NUL-A: the finding names the exact byte offset — offset=undefined want=14
//
// while (B) and (C) still pass. A guard that cannot fail is not a guard, and
// (B)+(C) alone cannot tell the two apart.
// ===========================================================================
{
  const { scanForNulBytes, formatFindingMessage } = await import(
    "../scripts/no-nul-bytes-scan.mjs"
  );

  const nulTmp = mkdtempSync(join(tmpdir(), "e10-nul-"));

  // (A) PLANTED NUL. Written byte-wise on purpose: this is the same technique
  // the failure message prescribes, and building the buffer here means the
  // fixture cannot be silently "fixed" by a helpful editor.
  const plantedPath = join(nulTmp, "planted.txt");
  const plantedBuf = Buffer.concat([
    Buffer.from("line one\nline ", "utf8"),
    Buffer.from([0x00]),
    Buffer.from(" two\n", "utf8"),
  ]);
  writeFileSync(plantedPath, plantedBuf);
  const WANT_OFFSET = plantedBuf.indexOf(0x00);

  const plantedRes = scanForNulBytes({ root: nulTmp, files: ["planted.txt"] });
  check(
    "e10 NUL-A: planted 0x00 produces exactly one finding",
    plantedRes.findings.length === 1,
    `got ${plantedRes.findings.length} finding(s): ${JSON.stringify(plantedRes.findings)}`,
  );
  check(
    "e10 NUL-A: the finding names the exact byte offset",
    plantedRes.findings[0]?.offset === WANT_OFFSET,
    `offset=${plantedRes.findings[0]?.offset} want=${WANT_OFFSET}`,
  );
  check(
    "e10 NUL-A: the finding names the line the byte falls on",
    plantedRes.findings[0]?.line === 2,
    `line=${plantedRes.findings[0]?.line} want=2`,
  );
  // The remedy text is load-bearing: the obvious fix (re-edit the file) is
  // what CREATES the byte, so the message has to name the write technique and
  // the verification command or the operator loops.
  const remedy = plantedRes.findings[0]
    ? formatFindingMessage(plantedRes.findings[0], nulTmp)
    : "";
  check(
    "e10 NUL-A: the failure message names the file and the byte offset",
    remedy.includes("planted.txt") && remedy.includes(String(WANT_OFFSET)),
    `message=${remedy}`,
  );
  check(
    "e10 NUL-A: the failure message prescribes a byte-wise write and `file` verification",
    remedy.includes("BYTE-WISE") &&
      remedy.includes("Buffer.concat") &&
      remedy.includes("`file "),
    `message=${remedy}`,
  );

  // (B) NEGATIVE CONTROL.
  const cleanPath = join(nulTmp, "clean.txt");
  writeFileSync(cleanPath, "line one\nline two\n", "utf8");
  const cleanRes = scanForNulBytes({ root: nulTmp, files: ["clean.txt"] });
  check(
    "e10 NUL-B: a NUL-free file yields zero findings",
    cleanRes.findings.length === 0 && cleanRes.files_scanned === 1,
    `findings=${JSON.stringify(cleanRes.findings)} scanned=${cleanRes.files_scanned}`,
  );

  try {
    rmSync(nulTmp, { recursive: true, force: true });
  } catch {}

  // (C) LIVE. The tracked set of THIS workspace. `git ls-files` is the
  // enumerator, so the gitignored scratch trees (.claude/worktrees/**,
  // node_modules/, storage/) are excluded by construction rather than by a
  // skip list that could rot.
  const liveNul = scanForNulBytes({ root: WORKSPACE_ROOT });
  check(
    "e10 NUL-C LIVE: the enumeration was non-empty (absence is not a verdict)",
    liveNul.files_scanned > 0,
    `mode=${liveNul.mode} scanned=${liveNul.files_scanned}`,
  );
  check(
    `e10 NUL-C LIVE: zero 0x00 bytes across ${liveNul.files_scanned} tracked file(s) [mode=${liveNul.mode}]`,
    liveNul.findings.length === 0,
    liveNul.findings
      .slice(0, 10)
      .map((f) => formatFindingMessage(f, liveNul.root))
      .join("\n      "),
  );
}

if (failures > 0) {
  console.error(
    `\nno-key-leakage-in-artifacts: ${failures} FAIL\n` +
      `If a fixture is being false-flagged, add its identifying substring to FIXTURE_ALLOWLIST.\n` +
      `If a REAL key leaked, scrub it (replace with first-12-chars + "...") and re-run.`
  );
  process.exit(1);
}
console.log(
  `no-key-leakage-in-artifacts: PASS (scanned ${filteredTargets.length} file(s))`
);
process.exit(0);
