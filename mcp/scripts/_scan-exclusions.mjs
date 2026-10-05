// _scan-exclusions.mjs — ONE definition of "a directory a whole-repo scanner
// must not descend into".
//
// THE DEFECT CLASS THIS CLOSES (e10 — harness self-injury)
// -------------------------------------------------------
// Several tools in this repo enumerate the WHOLE workspace tree and then
// assert a global property over what they found: canonical block names are
// globally unique; no member inode has a second name outside its tree; no
// forbidden identifier appears in source. Each of those assertions is only
// meaningful over the repo's OWN content.
//
// The workspace also contains SCRATCH ROOTS — trees that are copies of the
// repo, or private to some other process, and are gitignored precisely
// because they are not the repo:
//
//   .claude/worktrees/<id>/   Claude Code workflow worktrees (.gitignore:62)
//   .git/                     the object store (and per-worktree admin dirs)
//   node_modules/             vendored third-party trees
//   storage/ .cache/ dist/ build/   generated output
//
// A scanner that descends into a scratch root reports the repo's own files as
// defective. Measured on 2026-08-20 with five sibling worktrees present,
// `scanTree("<MEMORY_ROOT>")` from canonical-block-scan.mjs
// returned 75 ERROR findings, every one of them a `duplicate_name` where the
// "duplicate" was a COPY of the very file being protected — including
// kb/build-plan.md, the file the canonical-block machinery exists to protect.
// The harness injured itself. Nothing was wrong with the repo.
//
// WHY ENTRY NAME, NEVER PATH PREFIX
// ---------------------------------
// The rule keys on the directory ENTRY NAME, not on an absolute-path prefix.
// A path-prefix rule ("anything under <MEMORY_ROOT>/.claude")
// would be correct for the live tree and WRONG for every mkdtemp fixture root
// — and the fixture roots are how the scanners are tested. Keying on the name
// means a planted `<mkdtemp>/.claude/worktrees/w1/kb/a.md` is excluded by the
// same code path that excludes the live one, so the hermetic arm actually
// tests the production rule.
//
// THE RULE ITSELF is not invented here. It is the rule
// mcp/test/no-key-leakage-in-artifacts.test.mjs:85 already implements
// correctly and has for rounds:
//
//     if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
//
// i.e. EVERY dot-directory is scratch, plus the named build/vendor dirs. That
// is deliberately broader than an enumerated list: the next scratch root some
// tool invents will be a dot-dir too (.venv, .pytest_cache, .turbo), and a
// rule that has to be edited to stay correct is the rule that rots. The named
// set below exists so callers that want to name-check a specific known root
// (or print one) have a symbol to point at — it is a SUPERSET convenience,
// not the whole predicate.
//
// DISCIPLINE
//   - Zero dependencies (not even node builtins). Pure string predicates.
//   - Lives in scripts/ so both the scripts-tier scanners can import it
//     without a lib/ dependency edge. mcp/scripts/ is not covered by the
//     no-orphan-exports gate (LIB_ROOT = mcp/lib), so a shared scripts-tier
//     module is a legal home.
//   - Read-only by construction: this module observes names, nothing else.

/**
 * Directory entry names that are scratch/vendor/generated roots by name.
 *
 * `.claude` is the entry this node adds: it is the parent of
 * `.claude/worktrees/<id>/`, each of which is a FULL COPY of the repo.
 * The rest are the set canonical-block-scan.mjs already carried, preserved
 * verbatim so its exported SKIP_DIRS shape is unchanged for any caller.
 */
export const SCRATCH_DIR_NAMES = Object.freeze(
  new Set([
    ".claude",
    ".git",
    "node_modules",
    "storage",
    ".cache",
    "dist",
    "build",
  ]),
);

/**
 * isScratchDirName — should a whole-repo walker refuse to descend into a
 * directory with this ENTRY NAME?
 *
 * True for:
 *   - any name beginning with "." other than the "." / ".." pseudo-entries
 *     (readdirSync never yields those, but a hand-built list might)
 *   - the named vendor/generated dirs in SCRATCH_DIR_NAMES
 *
 * @param {string} name a single directory entry name (NOT a path)
 * @returns {boolean}
 */
export function isScratchDirName(name) {
  if (typeof name !== "string" || name.length === 0) return false;
  if (name === "." || name === "..") return false;
  if (name.startsWith(".")) return true;
  return SCRATCH_DIR_NAMES.has(name);
}

/**
 * containsScratchSegment — post-hoc assertion primitive: does this path pass
 * THROUGH a scratch root at any depth?
 *
 * This is the shape a gate asserts against ("no file this scanner returned
 * may live under a scratch root"), which is a different question from
 * "should I descend into this entry" — hence a separate export rather than a
 * split of the same call. Accepts both separators so a Windows-style path in
 * a fixture cannot slip past.
 *
 * @param {string} absPath
 * @returns {boolean}
 */
export function containsScratchSegment(absPath) {
  if (typeof absPath !== "string" || absPath.length === 0) return false;
  for (const seg of absPath.split(/[\\/]+/)) {
    if (isScratchDirName(seg)) return true;
  }
  return false;
}
