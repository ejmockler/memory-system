// r25-no-real-reads.test.mjs — R25+R26 bundle hermeticity gate.
//
// Asserts that NO test file introduced by the R25+R26 bundle reads from a
// production-only path. The R25/R26 surface introduces:
//   - mcp/test/ingest/salience-cascade.test.mjs
//   - mcp/test/ingest/salience-knn-backend.test.mjs
//   - mcp/test/ingest/stage0-modules.test.mjs
//   - mcp/test/recall/golden-queries.test.mjs
//   - mcp/test/recall-log-persistence.test.mjs
//   - mcp/test/tools/recall-integration.test.mjs
//   - mcp/test/watermark-multi-source.test.mjs
//   - mcp/test/daemons/watermark-multisource.test.mjs
//   - mcp/test/hermeticity/r25-no-real-reads.test.mjs   (this file)
//
// Forbidden production paths (substring match against each test file body —
// no false-positive risk because these are all absolute paths nobody quotes
// outside of a real-data read):
//   - <home>/Library/Messages/chat.db
//   - <home>/Library/Application Support/Knowledge/knowledgeC.db
//   - <checkout>/storage/sources/imessage.jsonl
//   - <checkout>/storage/sources/screentime.jsonl
//   - <checkout>/storage/sources/git-log.jsonl
//   - <checkout>/storage/sources/github-events.jsonl
//   - <checkout>/storage/sources/chat-claude-code.jsonl
// where <home> is os.homedir() and <checkout> is this checkout's root, both
// derived at runtime, PLUS the home-independent tail of each (e.g.
// `/Library/Messages/chat.db`, `memory-system/storage/sources/<name>.jsonl`)
// so the guard bites on any machine and for any install location.
//
// Allowed test-input paths (each R25 test fixture lives under one of these):
//   - test/.tmp/ (per-test tmpdir)
//   - test/fixtures/ (committed synthetic fixtures)
//   - os.tmpdir() return value (synthesized at runtime, not literal)
//
// One assertion per (test_file, forbidden_path) pair. Symmetric: this file
// IS itself an R25 test file, but it MAY name the forbidden paths because
// they appear here as deny-list string literals — the inline allow-marker
// `spec-sweep:allow` on each forbidden-path declaration line handles the
// spec-sweep gate; the self-check below skips this file.

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, basename, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_ROOT = join(__dirname, "..");
const SELF_BASENAME = basename(__filename);

// R25+R26 test file inventory. The test fails on any file that imports/reads
// a production path. Paths are relative to TEST_ROOT.
const R25_TEST_FILES = [
  "ingest/salience-cascade.test.mjs",
  "ingest/salience-knn-backend.test.mjs",
  "ingest/stage0-modules.test.mjs",
  "recall/golden-queries.test.mjs",
  "recall-log-persistence.test.mjs",
  "tools/recall-integration.test.mjs",
  "watermark-multi-source.test.mjs",
  "daemons/watermark-multisource.test.mjs",
];

// Forbidden production paths. Each entry is the EXACT string a real-data
// reader would substring-match against. Substring search avoids the need to
// model interpolation / template-string assembly — even a fully-constructed
// path would still contain `/Library/Messages/chat.db` somewhere on the line.
//
// Two forms per target. The host-specific absolute form is derived at runtime
// from os.homedir() / this checkout's root (no literal home path lives in the
// source). The home-independent TAIL is a substring of every absolute form —
// including one written for a different user or install directory — so it is
// never looser than a literal absolute path and still bites on any machine.
const HOME_DIR = homedir();
const CHECKOUT_ROOT = join(TEST_ROOT, "..", "..");
const FORBIDDEN_PATHS = [
  HOME_DIR + "/Library/Messages/chat.db",                                      // spec-sweep:allow
  HOME_DIR + "/Library/Application Support/Knowledge/knowledgeC.db",           // spec-sweep:allow
  CHECKOUT_ROOT + "/storage/sources/imessage.jsonl",                           // spec-sweep:allow
  CHECKOUT_ROOT + "/storage/sources/screentime.jsonl",                         // spec-sweep:allow
  CHECKOUT_ROOT + "/storage/sources/git-log.jsonl",                            // spec-sweep:allow
  CHECKOUT_ROOT + "/storage/sources/github-events.jsonl",                      // spec-sweep:allow
  CHECKOUT_ROOT + "/storage/sources/chat-claude-code.jsonl",                   // spec-sweep:allow
  "/Library/Messages/chat.db",                                                 // spec-sweep:allow
  "/Knowledge/knowledgeC.db",                                                  // spec-sweep:allow
  "memory-system/storage/sources/imessage.jsonl",                              // spec-sweep:allow
  "memory-system/storage/sources/screentime.jsonl",                            // spec-sweep:allow
  "memory-system/storage/sources/git-log.jsonl",                               // spec-sweep:allow
  "memory-system/storage/sources/github-events.jsonl",                         // spec-sweep:allow
  "memory-system/storage/sources/chat-claude-code.jsonl",                      // spec-sweep:allow
];

// Allowed synthetic-fixture path prefixes — these are the substrings each
// R25 test file MUST use instead of the forbidden paths. We do NOT enforce
// presence (a test could use os.tmpdir() and have neither literal), but if
// a test file mentions any storage/sources/ path it MUST also be using a
// /.tmp/ or test/fixtures/ prefix nearby. This is a soft cross-check below.
const ALLOWED_SYNTHETIC_HINTS = [
  "/.tmp/",
  "test/fixtures/",
  "test-tmp-",
  "tmpdir(",                                                                   // spec-sweep:allow
];

let passed = 0;
function ok(msg) { passed++; console.log(`  ok ${msg}`); }

console.log("# r25-no-real-reads — R25/R26 hermeticity gate");

// ---- Inventory presence check --------------------------------------------
// Each R25 test file MUST exist (the R25 bundle's test surface is fixed).
// If a sibling agent renames a file without updating this gate, we want
// loud failure, not silent skip.
for (const rel of R25_TEST_FILES) {
  const full = join(TEST_ROOT, rel);
  assert.ok(
    existsSync(full),
    `R25 test file missing: ${rel} (expected at ${full}). ` +
    `Either restore the file or update R25_TEST_FILES in this gate.`,
  );
  ok(`R25 test file present: ${rel}`);
}

// ---- Forbidden-path scan --------------------------------------------------
// For each (file, forbidden_path) pair, assert the test file body does NOT
// contain the forbidden path string. This catches both:
//   (a) direct readFileSync / openSync / spawnSync of the real production
//       file
//   (b) lazy paths that quote the production path even if guarded behind
//       a process.env check — the latter is still drift because a future
//       refactor could remove the guard

for (const rel of R25_TEST_FILES) {
  const full = join(TEST_ROOT, rel);
  let body;
  try {
    body = readFileSync(full, "utf8");
  } catch (err) {
    assert.fail(`cannot read ${rel}: ${err.message}`);
  }
  for (const forbidden of FORBIDDEN_PATHS) {
    // Test file body must NOT include the forbidden path string.
    const idx = body.indexOf(forbidden);
    assert.ok(
      idx < 0,
      `${rel} contains forbidden production path "${forbidden}" at byte ${idx}. ` +
      `R25 tests must use synthetic fixtures under test/.tmp/ or test/fixtures/ only.`,
    );
    ok(`${rel} does not read ${forbidden}`);
  }
}

// ---- Self-check: this file IS allowed to name the forbidden paths --------
// We do NOT scan ourselves (this file's purpose is to enumerate them as
// deny-list strings). The R25_TEST_FILES inventory above intentionally
// excludes this file. Confirm that exclusion is enforced.
assert.ok(
  !R25_TEST_FILES.includes(`hermeticity/${SELF_BASENAME}`),
  `self-check: ${SELF_BASENAME} must NOT be in R25_TEST_FILES (this file is the deny-list itself)`,
);
ok(`self-check: ${SELF_BASENAME} correctly excluded from scan inventory`);

// ---- Soft synthetic-hint cross-check -------------------------------------
// For each R25 test file that DOES read jsonl content (any file mentioning
// `.jsonl` and either `readFileSync` or `writeFileSync`), require at least
// one allowed-synthetic hint in the same file body. This is a guard against
// future drift: if someone adds a real-path read without naming the full
// forbidden literal (e.g. via path.join), the hint check still flags
// suspicious patterns.
for (const rel of R25_TEST_FILES) {
  const full = join(TEST_ROOT, rel);
  const body = readFileSync(full, "utf8");
  const touchesJsonl = body.includes(".jsonl") &&
    (body.includes("readFileSync") || body.includes("writeFileSync") ||
     body.includes("appendFileSync") || body.includes("openSync"));
  if (!touchesJsonl) continue;
  const hasHint = ALLOWED_SYNTHETIC_HINTS.some((h) => body.includes(h));
  assert.ok(
    hasHint,
    `${rel} reads/writes .jsonl but has no synthetic-fixture hint ` +
    `(expected one of: ${ALLOWED_SYNTHETIC_HINTS.join(", ")}). ` +
    `Confirm the file uses a tmpdir-based path, not a literal production path.`,
  );
  ok(`${rel} uses synthetic-fixture hint for .jsonl I/O`);
}

console.log(`\n# r25-no-real-reads: ${passed} assertions passed`);
