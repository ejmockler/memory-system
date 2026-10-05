// forbidden-legacy-identifiers.js
//
// Single source of truth for the post-R32 legacy-eradication scan.
//
// Background (see kb/deprecation-discipline.md + kb/legacy-archive.md): when
// R25 introduced the row-by-row salience cascade as the new promotion path,
// the Phase-1 conversational-distillation pipeline (`tickOnce` + the
// `distillation-supervisor` launchd job + the `storage/distillation-queue/`
// claim ring + the `policy.distillation.batch.*` event family + the
// `policy.token.minted` flow) was supposed to be RETIRED in its own round.
// It was not; it ran for ~6 rounds in parallel, burned Gemini quota the
// cascade needed, and surfaced as a 14h watermark lag in
// `memory_health` at the start of R32. R32 closed it.
//
// The forbidden-identifiers list below is the discipline: every name on it
// is a hard-banned identifier in production-side scan paths. Adding code
// that references one fails CI via two gates: the regression test
// (`mcp/test/no-legacy-pipeline-references.test.mjs`) AND the spec-sweep
// (`scripts/spec-sweep.mjs`, category `legacy_pattern_seen`).
//
// Allowed locations (the ONLY places these names may appear):
//   1. `kb/legacy-archive.md`  - the operator-history record
//   2. `kb/deprecation-discipline.md`  - the policy that names the names
//   3. `mcp/lib/forbidden-legacy-identifiers.js`  - this file (the list)
//   4. `mcp/test/no-legacy-pipeline-references.test.mjs`  - the test that asserts absence
//   5. `scripts/spec-sweep.mjs`  - the gate that calls into this list
//   6. `mcp/test/embed-callers-migrate.test.mjs`  - asserts the retired
//      `embedding_pending` marker never reappears; it must name it to assert it
//
// Anywhere else: drift.
//
// Format: each entry is `{ id, pattern, note }`. The `pattern` is a JS
// `RegExp` source string ANCHORED so substring false-positives are not
// raised (e.g. `tickOnce` must not match `tickSourcesOnce`).
//
// ES module. No external dependencies. Used by both the regression test
// and the spec-sweep extension to guarantee one truth.

// Regex helper: a "word-ish" boundary that treats `_`, `.` and `-` as part
// of the identifier (so `policy.distillation.batch.failed` matches as a
// whole token and `tickOnce` does not match inside `tickSourcesOnce`). We
// build (?<![A-Za-z0-9_.-])TERM(?![A-Za-z0-9_.-]) by hand because JS regex
// supports lookbehind in Node >=10.
function boundedRe(literal) {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(?<![A-Za-z0-9_.\\-])${escaped}(?![A-Za-z0-9_.\\-])`;
}

// FORBIDDEN_IDENTIFIERS - frozen array of every name R32 retired.
//
// Categories (for human reading; the scanner treats all entries uniformly):
//   * pipeline-process    distillation-supervisor, queue dirs, tickOnce
//   * pipeline-events     policy.distillation.batch.*, policy.token.minted
//   * pipeline-consts     DISTILLATION_IDLE_WATERMARK_SECONDS, etc.
//   * connector-residuals gemini-cli, python-sdk, GEMINI_CLI_, PYTHON_SDK_
//   * cascade-residuals   embedding_pending (the R29.3 dead reader flag)
//   * key-pool-residuals  GEMINI_KEY_COOLDOWN_HOURS (the R30 dead cap)
//
// Note on `tickOnce`: the lookaround boundary above already prevents matching
// inside `tickSourcesOnce`. No additional carve-out needed.
export const FORBIDDEN_IDENTIFIERS = Object.freeze([
  // ---- pipeline-process ----
  {
    id: "distillation-supervisor",
    pattern: boundedRe("distillation-supervisor"),
    note: "R32 retired the Phase-1 launchd supervisor; the row-by-row cascade is the only promotion path now",
  },
  {
    id: "distillation-queue",
    pattern: boundedRe("distillation-queue"),
    note: "R32 deleted storage/distillation-queue/{pending,in-flight,done,failed,poisoned}/",
  },
  {
    id: "tickOnce",
    pattern: boundedRe("tickOnce"),
    note: "R32 removed watermark.tickOnce (the conversation-batch path); tickSourcesOnce is the cascade entry",
  },
  {
    id: "distillation-state",
    pattern: boundedRe("distillation-state"),
    note: "R32.1: health.js was silently reading policy/distillation-state.json after the supervisor died; the on-disk file is renamed to watermark-state.json and any 'distillation-state' reference is drift",
  },
  {
    id: "distillation-state.json",
    pattern: boundedRe("distillation-state.json"),
    note: "R32.1: explicit filename form — the bounded-regex on `distillation-state` does not match when followed by `.json` because `.` is an identifier character; this entry catches the literal path string",
  },
  // ---- pipeline-events ----
  {
    id: "policy.distillation.batch.enqueued",
    pattern: boundedRe("policy.distillation.batch.enqueued"),
    note: "R32 removed the distillation-supervisor that emitted this event kind",
  },
  {
    id: "policy.distillation.batch.failed",
    pattern: boundedRe("policy.distillation.batch.failed"),
    note: "R32 removed the distillation-supervisor that emitted this event kind",
  },
  {
    id: "policy.distillation.batch.poisoned",
    pattern: boundedRe("policy.distillation.batch.poisoned"),
    note: "R32 removed the distillation-supervisor that emitted this event kind",
  },
  {
    id: "policy.distillation.batch.suppressed_by_hook",
    pattern: boundedRe("policy.distillation.batch.suppressed_by_hook"),
    note: "R32 removed the distillation-supervisor that emitted this event kind",
  },
  {
    id: "policy.token.minted",
    pattern: boundedRe("policy.token.minted"),
    note: "R32 removed the supervisor that minted tokens at trigger time; verifyToken in distill-promote-fact handler stays for manual operator calls",
  },
  // ---- pipeline-consts ----
  {
    id: "DISTILLATION_IDLE_WATERMARK_SECONDS",
    pattern: boundedRe("DISTILLATION_IDLE_WATERMARK_SECONDS"),
    note: "R32 deleted the idle-watermark constant that gated tickOnce batch creation",
  },
  {
    id: "DISTILLATION_BATCH_MAX_TURNS",
    pattern: boundedRe("DISTILLATION_BATCH_MAX_TURNS"),
    note: "R32 deleted the per-batch turn cap; no batches are built anymore",
  },
  {
    id: "POISON_THRESHOLD",
    pattern: boundedRe("POISON_THRESHOLD"),
    note: "R32 deleted the supervisor failure-count cap that promoted batches to poisoned/",
  },
  // ---- connector-residuals ----
  {
    id: "gemini-cli",
    pattern: boundedRe("gemini-cli"),
    note: "R28.1 removed the gemini-cli connector; R32 closed the residual references (state dir, KB rows, comments)",
  },
  {
    id: "python-sdk",
    pattern: boundedRe("python-sdk"),
    note: "R28.1 removed the python-sdk connector; R32 closed the residual references",
  },
  {
    id: "GEMINI_CLI_",
    pattern: boundedRe("GEMINI_CLI_"),
    note: "R28.1 removed the gemini-cli env-var family; R32 closed the residual references",
  },
  {
    id: "PYTHON_SDK_",
    pattern: boundedRe("PYTHON_SDK_"),
    note: "R28.1 removed the python-sdk env-var family; R32 closed the residual references",
  },
  // ---- cascade-residuals ----
  {
    id: "embedding_pending",
    pattern: boundedRe("embedding_pending"),
    note: "R29.3 declared the deferred-embed flag dead; the cursor parks at EMBED_DEFERRED instead",
  },
  // ---- key-pool-residuals ----
  {
    id: "GEMINI_KEY_COOLDOWN_HOURS",
    pattern: boundedRe("GEMINI_KEY_COOLDOWN_HOURS"),
    note: "R30 removed the daily-cooldown env var from the key pool; structural-throttle-only now",
  },
]);

// SCAN_ROOTS - absolute paths the regression test and spec-sweep scan.
// Computed lazily by the caller because callers need the HOME-relative root.
// Kept as a function so dependents can override for tests.
//
// R32.1 added `kb/` to the scan roots. The R32 brutalist round found six
// live operator-facing kb docs (architecture.md, glossary.md, mcp-surface.md,
// agent-integration.md, thesis.md, api-key-pool.md) still describing the
// retired conversational-distillation pipeline as normative. Those docs are
// in scope; legitimate references survive only in the two allow-listed kb
// files (kb/legacy-archive.md, kb/deprecation-discipline.md).
export function defaultScanRoots(memorySystemRoot) {
  return [
    `${memorySystemRoot}/mcp`,
    `${memorySystemRoot}/daemons`,
    `${memorySystemRoot}/scripts`,
    `${memorySystemRoot}/kb`,
    `${memorySystemRoot}/package.json`,
  ];
}

// EXCLUDED_PATH_SUFFIXES - paths whose RELATIVE form (from memory-system root)
// ends with one of these are skipped. Order matters only for documentation:
// the first three are the "definitional" allowed locations from the header.
export const EXCLUDED_PATH_SUFFIXES = Object.freeze([
  "kb/legacy-archive.md",
  "kb/deprecation-discipline.md",
  "mcp/lib/forbidden-legacy-identifiers.js",
  "mcp/test/no-legacy-pipeline-references.test.mjs",
  "scripts/spec-sweep.mjs",
  // Same class as the two entries directly above: a test that asserts a
  // RETIRED identifier stays retired must NAME that identifier to do its job.
  // This suite pins `embedding_pending` (the R29.3 dead reader flag) by
  // asserting the marker never reappears in an emitted feature bag; without
  // the literal name there is no assertion. Both scanners flagged those lines
  // as drift, which inverted the gate: the file guarding the ban was the only
  // thing failing the ban.
  //
  // ACCEPTED COST, stated plainly: exclusion is whole-FILE, not per-line, so
  // this file is now entirely unscanned. A future genuinely-drifting reference
  // added anywhere in it will NOT be caught by either scanner. That is exactly
  // the cost already accepted for the two sibling entries above; it is not a
  // new kind of hole, and it does not reduce coverage of any production path.
  "mcp/test/embed-callers-migrate.test.mjs",
]);

// EXCLUDED_PATH_SEGMENTS - any path containing one of these segments is
// skipped regardless of position. Used to filter VCS, build, vendor, and
// review trees.
//
// e10: `/.claude/` is LATENT-HAZARD CLOSURE, not a live fix. This scanner is
// safe TODAY only because `defaultScanRoots` narrows it to mcp/, daemons/,
// scripts/, kb/ and package.json — it never reaches `.claude/worktrees/<id>/`,
// where Claude Code keeps FULL COPIES of this repo. The moment any caller
// passes the workspace root (a plausible "scan everything" change), every
// forbidden identifier in every sibling worktree would be reported against
// this repo, and the harness would be accusing the operator of the harness's
// own state. Two other whole-repo enumerators had exactly that bug live
// (canonical-block-scan.mjs, verify-legacy-tree-deletable.mjs); this entry
// costs one line and removes the third from the class. The predicate ITSELF
// lives once, in mcp/scripts/_scan-exclusions.mjs — this list is a lib-tier
// path-segment filter with a different shape and no dependency edge to
// scripts/, so the segment is named here rather than imported.
export const EXCLUDED_PATH_SEGMENTS = Object.freeze([
  "/node_modules/",
  "/.git/",
  "/.claude/",
  "/dist/",
  "/build/",
  "/reviews/",
  "/vendor/",
  "/tmp/",
]);

// File extensions the scanner reads. Anything else is treated as binary /
// out-of-scope. `package.json` matches by name in addition to this.
//
// R32.1 added `.md` so the kb/ tree (added to defaultScanRoots in the same
// round) is actually inspected. Allow-listed kb meta-docs are filtered out
// via EXCLUDED_PATH_SUFFIXES, not via the extension list.
export const SCANNED_EXTENSIONS = Object.freeze([
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".sh",
  ".md",
]);

// stripCommentsAndStrings - line-level normaliser that turns the SUBSTRING-
// search problem into an IDENTIFIER-search problem. Removes:
//   * `// ...` line comments to end-of-line
//   * `/* ... */` block comments (single-line spans only — multi-line block
//     comments are handled by tracking state across lines in the caller)
//   * `"..."`, `'...'`, and `` `...` `` string literals (single-line spans
//     only; same caveat)
//
// Returns the stripped line. Note: a forbidden identifier that appears
// ONLY inside a string literal in production code is still drift (e.g.
// `JSON.stringify({kind: "policy.token.minted"})` would smuggle the kind
// through). So we do NOT strip strings inside production code; we only
// strip comments. The TEST file (when it scans itself, which is excluded)
// is the one exception, and it is excluded by path anyway.
//
// SHELL files: strip `# ...` line comments.
export function stripComments(line, ext) {
  if (ext === ".sh") {
    // Strip from first unquoted `#` to EOL. Naive: treat any `#` not
    // preceded by `\\` as a comment start. Quote-tracking is overkill for
    // the scan domain (the production shell scripts are simple).
    const hashIdx = line.indexOf("#");
    if (hashIdx === 0) return "";
    if (hashIdx > 0 && line[hashIdx - 1] !== "\\") return line.slice(0, hashIdx);
    return line;
  }
  // JS-like.
  let out = "";
  let i = 0;
  while (i < line.length) {
    const two = line.slice(i, i + 2);
    if (two === "//") {
      // Rest of line is a comment.
      break;
    }
    if (two === "/*") {
      // Block comment on this line; skip to closing `*/` if present, else EOL.
      const closeIdx = line.indexOf("*/", i + 2);
      if (closeIdx < 0) {
        // Unterminated block comment on this line — drop rest.
        break;
      }
      i = closeIdx + 2;
      continue;
    }
    out += line[i];
    i += 1;
  }
  return out;
}

// scanLineForForbidden - returns array of `{ id, note }` hits for the
// (stripped) line. Skips identifiers that don't appear at all (cheap
// substring test) before applying the bounded regex.
export function scanLineForForbidden(strippedLine) {
  const hits = [];
  for (const { id, pattern, note } of FORBIDDEN_IDENTIFIERS) {
    // Cheap substring pre-filter.
    if (strippedLine.indexOf(id) < 0) continue;
    const re = new RegExp(pattern);
    if (re.test(strippedLine)) {
      hits.push({ id, note });
    }
  }
  return hits;
}

// isExcludedPath - relative path (forward-slash, from memory-system root)
// is in the allow-list of files that may legitimately mention forbidden
// identifiers. Wraps the input in `/` on both sides so leading and trailing
// segment matches both work (e.g. `reviews/foo.md` is matched by segment
// `/reviews/`).
export function isExcludedPath(relPath) {
  const wrapped = "/" + relPath + "/";
  for (const seg of EXCLUDED_PATH_SEGMENTS) {
    if (wrapped.includes(seg)) return true;
  }
  for (const suf of EXCLUDED_PATH_SUFFIXES) {
    if (relPath.endsWith(suf)) return true;
  }
  return false;
}

// isScannedFile - extension or basename indicates the file is a scan target.
export function isScannedFile(relPath) {
  if (relPath.endsWith("/package.json") || relPath === "package.json") return true;
  for (const ext of SCANNED_EXTENSIONS) {
    if (relPath.endsWith(ext)) return true;
  }
  return false;
}
