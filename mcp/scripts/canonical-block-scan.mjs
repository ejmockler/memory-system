// canonical-block-scan.mjs
//
// R34 B12 — Canonical-content-block markers.
//
// PROBLEM (R32.1 / R33): the source_msg_id formula
//   source_msg_id = sha256(canonical_json({conversation_id, content_sha256,
//                                          prev_source_msg_id}))
// was DELETED from kb/build-plan.md as a side-effect of stubbing Phase 1 with
// "RETIRED (R32)". The formula was mixed with prose. The migrator could not
// see that it was MACHINE-CONSUMED by test/source-msg-id-preimage.test.mjs.
// The deletion went undetected until 3/28 assertions in that test failed in
// R33.
//
// FIX (this module): make machine-consumed KB content STRUCTURALLY DISTINCT
// from prose by wrapping it in CANONICAL blocks:
//
//   <!-- BEGIN-CANONICAL: <name> -->
//   ... content (formula, schema, identifier list, etc) ...
//   <!-- END-CANONICAL: <name> -->
//
// Consumers (tests, prod code) read content by NAME via extractCanonical()
// instead of regex-on-prose. Any edit that mutates the inner content of a
// canonical block is FLAGGED unless the new content_sha256 is on the
// allowlist in mcp/policy/canonical-allowlist.json.
//
// CLI:
//   canonical-block-scan.mjs                     -> scan kb/ + emit index
//   canonical-block-scan.mjs --root=<abs>        -> scan an arbitrary tree
//   canonical-block-scan.mjs --json              -> machine-readable output
//   canonical-block-scan.mjs --allowlist=<path>  -> override allowlist path
//   canonical-block-scan.mjs --emit-index=<path> -> write index JSON
//
// Library exports (ES modules):
//   parseCanonicalBlocks(text)        -> array of { name, content, sha256,
//                                                   start_line, end_line }
//   extractCanonical(filePath, name)  -> string content (throws if missing)
//   scanTree(rootAbs, opts?)          -> array of { file, blocks }
//   diffAgainstAllowlist(index, allowlist) -> array of findings
//
// Exit codes:
//   0 = no findings (every block sha matches allowlist OR allowlist absent
//       in --bootstrap mode)
//   1 = at least one finding (block mutated without allowlist update; or
//       duplicate name; or unbalanced markers)
//
// Discipline:
//   - No new deps. Node stdlib only.
//   - HERMETIC: writes nothing under storage/.
//   - Honors PRESERVATION BOUNDARY: this is a scripts/ tool; no lib/ touched.

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join, relative, dirname } from "node:path"; import { fileURLToPath } from "node:url";

import { SCRATCH_DIR_NAMES, isScratchDirName } from "./_scan-exclusions.mjs";

const BEGIN_RE = /^<!--\s*BEGIN-CANONICAL:\s*([A-Za-z0-9_.\-]+)\s*-->\s*$/;
const END_RE = /^<!--\s*END-CANONICAL:\s*([A-Za-z0-9_.\-]+)\s*-->\s*$/;

function sha256Hex(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

// Parse a markdown text and return all canonical blocks found in it.
// A block runs from the line AFTER its BEGIN marker through the line BEFORE
// its END marker, inclusive on both ends of the inner content. Trailing
// newline on the content is preserved iff the source file had one before
// END-CANONICAL.
export function parseCanonicalBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  const errors = [];
  let openName = null;
  let openStart = -1;
  let buf = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const mBegin = BEGIN_RE.exec(line);
    const mEnd = END_RE.exec(line);
    if (mBegin) {
      if (openName != null) {
        errors.push({
          kind: "unbalanced_begin",
          name: mBegin[1],
          line: i + 1,
          detail: `BEGIN-CANONICAL ${mBegin[1]} while ${openName} still open`,
        });
      }
      openName = mBegin[1];
      openStart = i + 1; // 1-indexed line of BEGIN marker
      buf = [];
      continue;
    }
    if (mEnd) {
      if (openName == null) {
        errors.push({
          kind: "unbalanced_end",
          name: mEnd[1],
          line: i + 1,
          detail: `END-CANONICAL ${mEnd[1]} without matching BEGIN`,
        });
        continue;
      }
      if (mEnd[1] !== openName) {
        errors.push({
          kind: "name_mismatch",
          name: openName,
          line: i + 1,
          detail: `BEGIN ${openName} closed by END ${mEnd[1]}`,
        });
      }
      const content = buf.join("\n");
      blocks.push({
        name: openName,
        content,
        sha256: sha256Hex(content),
        start_line: openStart,
        end_line: i + 1,
      });
      openName = null;
      buf = [];
      continue;
    }
    if (openName != null) {
      buf.push(line);
    }
  }
  if (openName != null) {
    errors.push({
      kind: "unclosed_begin",
      name: openName,
      line: openStart,
      detail: `BEGIN-CANONICAL ${openName} never closed`,
    });
  }
  return { blocks, errors };
}

// Read a single canonical block from a markdown file by name. Throws if the
// file does not exist, contains no block by that name, or contains more than
// one block by that name. Consumers (tests + prod) use this to bind to
// canonical content by structural identity rather than anchor-text.
export function extractCanonical(filePath, name) {
  if (!existsSync(filePath)) {
    throw new Error(`extractCanonical: file does not exist: ${filePath}`);
  }
  const text = readFileSync(filePath, "utf8");
  const { blocks, errors } = parseCanonicalBlocks(text);
  if (errors.length > 0) {
    throw new Error(
      `extractCanonical: ${filePath} has structural errors: ` +
        JSON.stringify(errors),
    );
  }
  const hits = blocks.filter((b) => b.name === name);
  if (hits.length === 0) {
    throw new Error(
      `extractCanonical: no canonical block named '${name}' in ${filePath}`,
    );
  }
  if (hits.length > 1) {
    throw new Error(
      `extractCanonical: ${hits.length} blocks named '${name}' in ${filePath}`,
    );
  }
  return hits[0].content;
}

// Walk a tree and collect canonical blocks from every .md file.
//
// SKIP_DIRS is retained as an export-shaped constant (its members are the
// named vendor/generated roots) but it is NO LONGER the predicate. The
// predicate is `isScratchDirName` from ./_scan-exclusions.mjs — ONE definition
// shared with verify-legacy-tree-deletable.mjs, so the two whole-repo walkers
// cannot drift apart.
//
// WHAT WAS BROKEN (e10). The old body read:
//
//   if (e.name.startsWith(".") && e.name !== "." && e.name !== "..") {
//     if (SKIP_DIRS.has(e.name)) continue;
//   }
//   if (SKIP_DIRS.has(e.name)) continue;
//
// The guarded branch is byte-identical to the unguarded check that follows,
// so it skipped NOTHING that the next line did not already skip — dead code
// wearing the costume of a hidden-directory rule. Every dot-directory not
// literally named in SKIP_DIRS was descended into. `.claude/worktrees/<id>/`
// holds FULL COPIES of this repo, so with five sibling worktrees on disk the
// live scan reported 75 duplicate_name ERRORs whose "duplicate" was the
// canonical file itself. Measured before the fix; 0 after.
const SKIP_DIRS = new Set(SCRATCH_DIR_NAMES);

/**
 * scanTree — collect canonical blocks from every .md file under rootAbs.
 *
 * @param {string} rootAbs
 * @param {{skipDirNames?: (name: string) => boolean}} [opts]
 *   skipDirNames — injectable override of the exclusion predicate, so a test
 *   can drive the walker's descent decisions without planting directories.
 *   Defaults to the shared `isScratchDirName`.
 */
export function scanTree(rootAbs, opts = {}) {
  const skipDirName =
    typeof opts.skipDirNames === "function" ? opts.skipDirNames : isScratchDirName;
  const out = [];
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && skipDirName(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        const text = readFileSync(full, "utf8");
        if (!text.includes("BEGIN-CANONICAL")) continue;
        const { blocks, errors } = parseCanonicalBlocks(text);
        out.push({ file: full, blocks, errors });
      }
    }
  }
  if (statSync(rootAbs).isDirectory()) walk(rootAbs);
  return out;
}

// Build a flat index keyed by name. Duplicate names across files are
// flagged as findings (a canonical name MUST be globally unique so consumers
// have one source of truth).
export function buildIndex(scanResult) {
  const index = {};
  const findings = [];
  for (const { file, blocks, errors } of scanResult) {
    for (const err of errors) {
      findings.push({
        severity: "ERROR",
        kind: err.kind,
        file,
        name: err.name,
        line: err.line,
        detail: err.detail,
      });
    }
    for (const b of blocks) {
      if (index[b.name]) {
        findings.push({
          severity: "ERROR",
          kind: "duplicate_name",
          file,
          name: b.name,
          line: b.start_line,
          detail: `also defined in ${index[b.name].file}`,
        });
        continue;
      }
      index[b.name] = {
        file,
        sha256: b.sha256,
        start_line: b.start_line,
        end_line: b.end_line,
        content: b.content,
      };
    }
  }
  return { index, findings };
}

// Diff a fresh index against an allowlist. The allowlist is a JSON file:
//   {
//     "schema": "canonical-allowlist/v1",
//     "blocks": {
//       "<name>": {
//         "sha256": "<hex>",
//         "file": "<relpath>",
//         "consumers": ["<relpath>", ...],
//         "rationale": "<free text>"
//       }
//     }
//   }
//
// Findings:
//   - block in index, missing from allowlist  -> NEW (informational)
//   - block in allowlist, missing from index  -> DELETED (ERROR)
//   - block in both, sha256 differs           -> MUTATED (ERROR)
//   - allowlist file path differs from index  -> MOVED (ERROR)
export function diffAgainstAllowlist(index, allowlist, rootAbs) {
  const findings = [];
  const allow = (allowlist && allowlist.blocks) || {};
  const allowNames = Object.keys(allow);
  const indexNames = Object.keys(index);
  for (const name of indexNames) {
    const entry = index[name];
    const allowed = allow[name];
    if (!allowed) {
      findings.push({
        severity: "INFO",
        kind: "new_block",
        name,
        file: rootAbs ? relative(rootAbs, entry.file) : entry.file,
        sha256: entry.sha256,
        detail:
          "block exists in tree but not in allowlist; add to allowlist to lock its sha256",
      });
      continue;
    }
    if (allowed.sha256 !== entry.sha256) {
      findings.push({
        severity: "ERROR",
        kind: "mutated_block",
        name,
        file: rootAbs ? relative(rootAbs, entry.file) : entry.file,
        expected_sha256: allowed.sha256,
        actual_sha256: entry.sha256,
        detail:
          "canonical block content mutated; update allowlist iff this is intentional and consumers were updated in lockstep",
      });
    }
    const relIdxFile = rootAbs ? relative(rootAbs, entry.file) : entry.file;
    if (allowed.file && allowed.file !== relIdxFile) {
      findings.push({
        severity: "ERROR",
        kind: "moved_block",
        name,
        file: relIdxFile,
        expected_file: allowed.file,
        detail: "canonical block moved file; update allowlist entry",
      });
    }
  }
  for (const name of allowNames) {
    if (!index[name]) {
      findings.push({
        severity: "ERROR",
        kind: "deleted_block",
        name,
        expected_file: allow[name].file,
        expected_sha256: allow[name].sha256,
        detail:
          "canonical block listed in allowlist is missing from tree; restore it or remove from allowlist",
      });
    }
  }
  return findings;
}

// ---- CLI ---------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq < 0) out[a.slice(2)] = true;
    else out[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return out;
}

function defaultRoot() {
  // Default scan root = the kb/ dir of memory-system.
  // verify-edit pattern: callers usually run from mcp/ or memory-system/ root.
  return process.env.MEMORY_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

function defaultAllowlist() {
  return join(defaultRoot(), "mcp", "policy", "canonical-allowlist.json");
}

function isMainModule() {
  // ES modules: detect when run directly. Real paths on both sides, so a
  // space or a symlink in the invocation path cannot defeat the check.
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.root || defaultRoot());
  const allowlistPath = resolve(args.allowlist || defaultAllowlist());
  const scan = scanTree(root);
  const { index, findings: indexFindings } = buildIndex(scan);

  let allowlist = null;
  let allowlistExists = existsSync(allowlistPath);
  if (allowlistExists) {
    try {
      allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));
    } catch (e) {
      console.error(
        `canonical-block-scan: cannot read allowlist ${allowlistPath}: ${e.message}`,
      );
      process.exit(1);
    }
  }

  let diffFindings = [];
  if (allowlist) {
    diffFindings = diffAgainstAllowlist(index, allowlist, root);
  }

  const all = [...indexFindings, ...diffFindings];
  const errors = all.filter((f) => f.severity === "ERROR");

  if (args["emit-index"]) {
    const outPath = resolve(args["emit-index"]);
    // strip content from emitted index (sha256 is the binding identity)
    const flat = {};
    for (const [name, e] of Object.entries(index)) {
      flat[name] = {
        file: relative(root, e.file),
        sha256: e.sha256,
        start_line: e.start_line,
        end_line: e.end_line,
      };
    }
    writeFileSync(
      outPath,
      JSON.stringify(
        { schema: "canonical-index/v1", root, blocks: flat },
        null,
        2,
      ) + "\n",
    );
  }

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          root,
          allowlist_path: allowlistPath,
          allowlist_exists: allowlistExists,
          block_count: Object.keys(index).length,
          findings: all,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`canonical-block-scan: root=${root}`);
    console.log(`  blocks found: ${Object.keys(index).length}`);
    console.log(
      `  allowlist: ${allowlistExists ? allowlistPath : "(missing)"}`,
    );
    for (const f of all) {
      console.log(
        `  [${f.severity}] ${f.kind} name=${f.name || "-"} ${f.detail || ""}`,
      );
    }
    console.log(`  findings: ${all.length} (${errors.length} ERROR)`);
  }

  process.exit(errors.length === 0 ? 0 : 1);
}

if (isMainModule()) {
  main().catch((e) => {
    console.error(`canonical-block-scan: fatal: ${e.stack || e.message}`);
    process.exit(1);
  });
}
