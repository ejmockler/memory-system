#!/usr/bin/env node
// no-nul-bytes-scan.mjs — refuse a literal 0x00 byte in any TRACKED file.
//
// THE DEFECT THIS GUARDS (e10, hazard 2)
// --------------------------------------
// Source that needs to talk ABOUT a NUL byte — a `git ls-files -z` separator,
// a `\0` in a test fixture, an escape in a comment — must carry the two
// characters `\` and `0`. When a tool writes the file through a path that
// interprets the escape (a shell `printf`, a heredoc that is not quoted, an
// editor that resolves escapes on save), what lands on disk is the BYTE 0x00
// instead. The file still looks correct in every viewer that stops at the
// NUL, and:
//
//   * `grep` treats the file as BINARY and prints "Binary file ... matches"
//     instead of the line — so the very search you would run to find the
//     problem cannot see it. (`grep -a` can; that is the whole reason the
//     e10 investigation searched with -a throughout.)
//   * `git diff` shows "Binary files differ" — review sees nothing.
//   * Node's `readFileSync(p, "utf8")` returns the NUL happily, so a scanner
//     built on string search reports the file as clean.
//
// A defect that is invisible to grep, invisible to diff, and invisible to the
// repo's own string-based scanners cannot be found by looking harder. It has
// to be measured BYTE-WISE, which is what this program does.
//
// WHY A BLANKET RULE IS SAFE HERE (measured, not assumed)
// ------------------------------------------------------
// "No tracked file may contain 0x00" is only a usable rule if the repo has no
// legitimately binary tracked content. Measured 2026-08-20 on this workspace:
// all 712 tracked files report a text or application/json MIME type under
// `file --mime`, and ZERO of them contain a 0x00 byte. The guard therefore
// starts GREEN, and any future red is a real change rather than a backlog. If
// a genuinely binary artifact is ever tracked, that is the moment to add an
// explicit path allowlist — deliberately NOT pre-built here, because an empty
// allowlist cannot rot and a speculative one invites use.
//
// WHY `git ls-files`, NOT A WALK
// ------------------------------
// The tracked set is the set under review. It also excludes, by construction
// and without a skip list, the gitignored scratch trees that made the
// canonical-block scanner report the repo against itself — `.claude/`,
// `node_modules/`, `storage/`. When git is unavailable the walk degrades to
// the SHARED exclusion predicate in ./_scan-exclusions.mjs (one definition,
// not a second copy), and the envelope says which mode ran so a caller can
// tell a tracked-set result from a best-effort one.
//
// THE FALLBACK SET. A tree without `.git` (an unpacked archive, a copy) still
// has the per-host runtime data that .gitignore keeps out of the tracked set,
// and some of it is binary by design (ledger offset sidecars, indices). The
// walk therefore also skips, by path RELATIVE TO THE SCAN ROOT:
//   ledgers/ storage/ telemetry/ indices/ logs/      (top level only)
//   connectors/                                      (top level only)
//   vendor/node/ daemons/logs/ local-embedder/logs/ launchd/rendered/
//   policy/**  except policy/.gitignore              (top level only)
//   config/*.json  except config/*.example.json      (top level only)
//   hooks/hook-errors.jsonl   *.log
//   __pycache__/ directories and .DS_Store files     (at ANY depth)
// Root-relative on purpose, anchored the way .gitignore anchors each rule:
// mcp/policy, mcp/lib/** (mcp/lib/connectors included) and mcp/test/** hold
// tracked SOURCE under the same directory names and are still scanned. Only
// the two rules .gitignore leaves unanchored (python bytecode caches, Finder
// metadata) match at any depth. These names are NOT added to the shared
// scratch predicate, whose other callers must keep descending into them.
//
// READ-ONLY. This program opens files for reading and spawns `git ls-files`.
// It contains no write, append, mkdir, rename, or unlink call. It rewrites
// nothing it finds — a guard that repaired bytes would be indistinguishable
// from the tool that corrupted them.
//
// CLI
//   node mcp/scripts/no-nul-bytes-scan.mjs [--root=PATH] [--json]
//
// Exit codes
//   0  no 0x00 byte in any scanned file
//   1  at least one finding (or the scan could not enumerate anything)
//
// Library
//   scanForNulBytes({ root, files }) -> { root, mode, files_scanned,
//                                         findings: [{file, offset, line}] }
//   formatFindingMessage(finding, root) -> the operator-facing remedy text

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path"; import { fileURLToPath } from "node:url";

import { isScratchDirName } from "./_scan-exclusions.mjs";

const NUL = 0x00;

export const DEFAULT_ROOT = process.env.MEMORY_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * listTrackedFiles — the tracked set, via `git ls-files -z`.
 *
 * NUL-delimited on purpose: a filename may legally contain a newline, and
 * this program of all programs should not parse a byte-sensitive listing with
 * a line-sensitive splitter.
 *
 * @returns {string[]|null} absolute paths, or null when git could not answer
 */
export function listTrackedFiles(rootAbs) {
  const res = spawnSync("git", ["ls-files", "-z"], {
    cwd: rootAbs,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error || res.status !== 0 || !res.stdout) return null;
  const parts = res.stdout.toString("utf8").split("\0").filter(Boolean);
  if (parts.length === 0) return null;
  return parts.map((p) => join(rootAbs, p));
}

const RUNTIME_DATA_DIRS = Object.freeze(
  new Set([
    "ledgers",
    "storage",
    "telemetry",
    "indices",
    "logs",
    "connectors",
    "vendor/node",
    "daemons/logs",
    "local-embedder/logs",
    "launchd/rendered",
  ]),
);

/**
 * isRuntimeDataPath — is this root-relative path gitignored per-host runtime
 * data rather than source? Mirrors the runtime-data rules of the repo's
 * .gitignore. `rel` uses "/" separators and is relative to the scan root, so
 * `policy/x` matches and `mcp/policy/x` does not. Two rules are unanchored in
 * .gitignore and therefore match on the entry NAME at any depth: a
 * `__pycache__` directory and a `.DS_Store` file.
 *
 * @param {string} rel root-relative path, "/"-separated
 * @param {boolean} isDir whether the entry is a directory
 */
export function isRuntimeDataPath(rel, isDir) {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  if (isDir) {
    if (name === "__pycache__") return true;
    if (RUNTIME_DATA_DIRS.has(rel)) return true;
    // everything under top-level policy/ is state, except its .gitignore
    return rel.startsWith("policy/");
  }
  if (name === ".DS_Store") return true;
  if (rel.startsWith("policy/")) return rel !== "policy/.gitignore";
  if (rel === "hooks/hook-errors.jsonl") return true;
  if (rel.endsWith(".log")) return true;
  // top-level config/*.json is per-host configuration; the tracked
  // *.example.json templates beside it are source and stay scanned
  if (/^config\/[^/]+\.json$/.test(rel)) return !rel.endsWith(".example.json");
  // top-level connectors/ is skipped as a directory by the walk; this keeps
  // the same answer for a file path asked about directly
  return rel.startsWith("connectors/");
}

/**
 * walkFallbackFiles — degrade path when git is unavailable.
 *
 * Uses the SHARED scratch-root predicate. This mode can see untracked and
 * gitignored files that `git ls-files` would not, so its result is reported
 * under a different `mode` rather than being silently equated with the
 * tracked-set answer.
 *
 * It additionally skips gitignored runtime data (see isRuntimeDataPath) so a
 * tree that has been USED (a memory put, a daemon run) scans the same set git
 * mode would.
 */
export function walkFallbackFiles(rootAbs) {
  const out = [];
  const stack = [rootAbs];
  while (stack.length > 0) {
    const dir = stack.pop();
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      const p = join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      const rel = relative(rootAbs, p).split(sep).join("/");
      if (ent.isDirectory()) {
        if (isScratchDirName(ent.name)) continue;
        if (isRuntimeDataPath(rel, true)) continue;
        stack.push(p);
        continue;
      }
      if (ent.isFile() && !isRuntimeDataPath(rel, false)) out.push(p);
    }
  }
  return out.sort();
}

/**
 * scanForNulBytes — report every 0x00 byte in every scanned file.
 *
 * Reads each file as a BUFFER. A string read would be the same mistake the
 * guard exists to catch: `readFileSync(p, "utf8")` yields a JS string in
 * which the NUL is an ordinary character, and every string-based repo scanner
 * walks straight past it.
 *
 * `line` is the 1-indexed line the byte falls on, counted by 0x0A bytes
 * before the offset — so the message can point an operator at a place in an
 * editor, not just at a number.
 *
 * @param {{root?: string, files?: string[]}} [opts]
 * @returns {{root: string, mode: string, files_scanned: number,
 *            findings: Array<{file: string, offset: number, line: number}>}}
 */
export function scanForNulBytes(opts = {}) {
  const root = resolve(opts.root || DEFAULT_ROOT);
  let files = opts.files;
  let mode;
  if (Array.isArray(files)) {
    mode = "explicit";
    files = files.map((f) => resolve(root, f));
  } else {
    const tracked = listTrackedFiles(root);
    if (tracked) {
      mode = "git-tracked";
      files = tracked;
    } else {
      mode = "walk-fallback";
      files = walkFallbackFiles(root);
    }
  }

  const findings = [];
  let scanned = 0;
  for (const file of files) {
    let buf;
    try {
      const st = statSync(file);
      if (!st.isFile()) continue;
      buf = readFileSync(file);
    } catch {
      continue; // a path in the index but not on disk is not this guard's finding
    }
    scanned += 1;
    let line = 1;
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      if (b === 0x0a) {
        line += 1;
        continue;
      }
      if (b === NUL) findings.push({ file, offset: i, line });
    }
  }
  return { root, mode, files_scanned: scanned, findings };
}

/**
 * formatFindingMessage — the operator-facing text.
 *
 * A guard that only says "this is wrong" spends the operator's time twice:
 * once discovering the rule and once discovering the remedy. The remedy here
 * is genuinely non-obvious — the natural fix ("just edit the file") is what
 * produced the byte in the first place, because the write path is the
 * culprit, not the edit. So the message names the byte, the place, and the
 * WRITE TECHNIQUE that survives, plus the one-command verification.
 */
export function formatFindingMessage(finding, root) {
  const shown = root ? relative(root, finding.file) : finding.file;
  return (
    `${shown}: literal NUL byte (0x00) at byte offset ${finding.offset} (line ${finding.line}). ` +
    `A NUL makes this file BINARY to grep and git diff, so the defect hides from every ` +
    `default search. If you meant the two-character escape, write it BYTE-WISE — build the ` +
    `bytes yourself (Buffer.concat / fs.writeSync of the literal characters '\\' and '0') ` +
    `instead of letting a shell, heredoc, or editor interpret the escape — then verify with ` +
    `\`file ${shown}\` before committing: it must report a text MIME type, not binary.`
  );
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

function isMainModule() {
  // ES modules: detect when run directly. Real paths on both sides, so a
  // space or a symlink in the invocation path cannot defeat the check.
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.root || DEFAULT_ROOT);
  const result = scanForNulBytes({ root });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `no-nul-bytes-scan: root=${result.root} mode=${result.mode} files=${result.files_scanned}`,
    );
    for (const f of result.findings) {
      console.error(`  [ERROR] ${formatFindingMessage(f, result.root)}`);
    }
    console.log(`  findings: ${result.findings.length}`);
  }

  if (result.files_scanned === 0) {
    // Absence is not a verdict: a scan that read nothing has not cleared
    // anything, and must not be mistaken for a clean run.
    console.error(
      "no-nul-bytes-scan: scanned ZERO files — the enumeration failed; this is not a pass.",
    );
    process.exit(1);
  }
  process.exit(result.findings.length === 0 ? 0 : 1);
}

if (isMainModule()) main();
