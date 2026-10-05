#!/usr/bin/env node
// verify-legacy-tree-deletable.mjs — l7 (legacy-purge hypergraph).
//
// WHY THIS EXISTS
// ---------------
// The deletion case for `indices/gemini-embedding-001/` currently lives in a
// document, and a document's numbers rot. Every quantity that argument rests
// on — the tree's size, whether any member is hardlinked to something OUTSIDE
// the tree, whether the argument-less rebuild still names the legacy tree as
// its target, whether lexical coverage of the ACTIVE model still clears its
// floor — is a MEASUREMENT, and each one can change without anyone editing
// the .md that quotes it. This script re-measures all of them and turns the
// result into an exit code, so the operator's last step before an
// irreversible `rm -rf` is a command rather than a re-read.
//
// IT IS NOT AN AUTHORIZATION. Exit 0 means "the four predicates this script
// can measure are still true". It does not mean the deletion is a good idea,
// and it deletes nothing itself. The deletion argument itself is not shipped
// with this tree.
//
// WHAT IT REUSES RATHER THAN RE-DERIVES
// -------------------------------------
//   * COVERAGE: spawned, never reimplemented. `verify-lexical-coverage-gate.mjs`
//     (which itself owns no threshold — `assertCoverageFloor` in
//     lib/recall/bm25-coverage-probe.js does) is executed as a child process
//     with NO arguments, so it applies its own documented defaults: the ACTIVE
//     model, floor 99, manifest digest verified. There is deliberately no flag
//     here to skip it or to relax it — a permit that never measured coverage
//     would be exactly the "absence as a verdict" failure this program exists
//     to avoid.
//   * MANIFEST: `readActiveManifest` from lib/recall/index-manifest.js — the
//     same parse+shape reader `mcp/lib/tools/health.js` uses, so this script
//     and the health surface cannot disagree about what the manifest says.
//   * RESURRECTION PREDICATES: the real symbols are IMPORTED and CALLED —
//     `_defaultRebuildModelVersion()` and `resolvePublishModelVersion()` from
//     lib/recall/bm25-rebuild.js, `LEXICAL_INDEX_KEY` from
//     lib/recall/bm25-projection.js. Not grepped. A grep over a pre-chosen
//     file list would pass against a file that no longer runs.
//
// READ-ONLY, STATED PRECISELY
// ---------------------------
// This FILE contains no filesystem-mutating call: no write/append/mkdir/
// rename/rm/unlink/truncate, no write stream, no `open` for write. It reads
// directory entries, lstat metadata, and one small JSON file (the manifest).
// It never reads member BYTES — a 778 MB hash is the coverage gate's job on
// the ACTIVE tree, not this script's job on the legacy one. The transitive
// claim is NOT made: `index-manifest.js` contains atomic-rename sites, and
// only its READ export (`readActiveManifest`) is imported here. The child
// process it spawns makes the same scoped claim in its own header.
//
// ABSENCE IS NEVER A VERDICT
// --------------------------
// A tree that does not exist is exit 2 (`legacy_tree_absent`), never exit 0.
// "Nothing to delete" and "safe to delete" are different findings and this
// script refuses to collapse them. `--help` exits 2 for the same reason.
//
// USAGE
//   node mcp/scripts/verify-legacy-tree-deletable.mjs \
//     [--tree=PATH] [--scan-root=PATH] [--freshness-window-ms=N]
//
//   --tree=PATH               default: <MEMORY_ROOT>/indices/<legacy model>,
//                             where the legacy model id comes from
//                             BM25_REBUILD_LEGACY_MODEL_VERSION (the module's
//                             single reference to it), not a string literal.
//   --scan-root=PATH          default: MEMORY_ROOT. Where the outside-hardlink
//                             search walks. Only walked when some member has
//                             st_nlink > 1; an st_nlink of 1 is already proof
//                             that no second name exists anywhere.
//   --freshness-window-ms=N   default: 3600000 (1 h). REFUSE if the manifest
//                             was written inside this window: something wrote
//                             the tree moments ago, and the operator's
//                             inventory is describing a tree that is still
//                             moving. Deliberately much smaller than the
//                             ~6 h generation-publish cadence.
//   --help                    usage on stderr, exit 2.
//
// EXIT CODES
//   0  permit    — all four predicates measured and true
//   3  refuse    — a completed measurement that FAILED: a writer still
//                  defaults to the legacy tree, a member is hardlinked
//                  outside it, the manifest is inside the freshness window,
//                  or the coverage gate itself refused (its exit 3)
//   2  refuse    — nothing measured: bad invocation, absent/unreadable tree,
//                  unreadable manifest, or a coverage gate that could not
//                  measure (its exit 2)
//
// Output: exactly ONE line of JSON on stdout in every case.

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { lstatSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MEMORY_ROOT } from "../lib/config.js";
import {
  BM25_REBUILD_LEGACY_MODEL_VERSION,
  _defaultRebuildModelVersion,
  resolvePublishModelVersion,
} from "../lib/recall/bm25-rebuild.js";
import { LEXICAL_INDEX_KEY } from "../lib/recall/bm25-projection.js";
import { readActiveManifest } from "../lib/recall/index-manifest.js";
import { isScratchDirName } from "./_scan-exclusions.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Default freshness window. A manifest mtime INSIDE this window is a refusal:
 * the unattributed writer that produced generation 4 on 2026-08-17T13:21:19Z
 * was never identified, so "nothing has touched this tree for an hour" is the
 * strongest liveness statement available before an irreversible delete.
 */
export const LEGACY_TREE_FRESHNESS_WINDOW_MS = 3_600_000;

const COVERAGE_GATE = join(HERE, "verify-lexical-coverage-gate.mjs");

const USAGE = [
  "verify-legacy-tree-deletable.mjs — re-measure the legacy index tree's deletion predicates.",
  "",
  "  --tree=PATH               default: <MEMORY_ROOT>/indices/<legacy model id>",
  "  --scan-root=PATH          default: MEMORY_ROOT (outside-hardlink search root)",
  `  --freshness-window-ms=N   default: ${LEGACY_TREE_FRESHNESS_WINDOW_MS}`,
  "  --help                    this text (exit 2 — exit 0 means 'measured and clear')",
  "",
  "Exit: 0 permit | 3 refuse (measured failure) | 2 refuse (nothing measured).",
  "",
  "This script deletes nothing and authorizes nothing. It measures.",
].join("\n");

// ---------------------------------------------------------------------------
// Pure predicates (exported so the registered suite can drive them without a
// production path — see mcp/test/rebuild-target-retarget.test.mjs).
// ---------------------------------------------------------------------------

/**
 * evaluateFreshness — is the manifest still moving?
 *
 * PURE. Takes the two numbers rather than reading a clock or a stat, so the
 * test arms can pin both. `fresh: true` is the REFUSAL condition, which reads
 * backwards on purpose: freshness is the hazard here, not the goal.
 *
 * @param {{manifestMtimeMs: number, nowMs: number, windowMs?: number}} args
 * @returns {{fresh: boolean, age_ms: number|null, window_ms: number}}
 */
export function evaluateFreshness({
  manifestMtimeMs,
  nowMs,
  windowMs = LEGACY_TREE_FRESHNESS_WINDOW_MS,
}) {
  if (!Number.isFinite(manifestMtimeMs) || !Number.isFinite(nowMs)) {
    // A clock or stat we could not read is NOT a stale-enough verdict.
    return { fresh: true, age_ms: null, window_ms: windowMs };
  }
  const ageMs = nowMs - manifestMtimeMs;
  // A NEGATIVE age (manifest stamped in the future — clock skew, or a writer
  // mid-flight) counts as fresh. Treating it as "very old" would invert the
  // guard exactly when it matters most.
  return { fresh: ageMs < windowMs, age_ms: ageMs, window_ms: windowMs };
}

/**
 * assessResurrectionPredicates — will anything re-create the tree by DEFAULT?
 *
 * Calls the real resolvers rather than describing them. Both checks are about
 * the ARGUMENT-LESS / default path only: an operator who sets
 * MEMORY_BM25_REBUILD_TARGET_LEGACY=1, or passes --target=legacy, is asking
 * for the legacy tree by name and this script has no opinion about that.
 *
 * Note the env sensitivity is real and deliberate: `_defaultRebuildModelVersion`
 * reads process.env at CALL time, so running this script with
 * MEMORY_BM25_REBUILD_TARGET_LEGACY=1 in the environment correctly REFUSES.
 *
 * @returns {{ok: boolean, legacy_model_version: string|undefined, checks: Array}}
 */
export function assessResurrectionPredicates() {
  const legacy = BM25_REBUILD_LEGACY_MODEL_VERSION;
  const checks = [
    {
      name: "default_rebuild_target_is_not_legacy",
      symbol: "_defaultRebuildModelVersion (lib/recall/bm25-rebuild.js)",
      value: _defaultRebuildModelVersion(),
      ok: _defaultRebuildModelVersion() !== legacy,
    },
    {
      name: "lexical_projection_publish_target_is_not_legacy",
      symbol: "resolvePublishModelVersion (lib/recall/bm25-rebuild.js)",
      value: resolvePublishModelVersion(LEXICAL_INDEX_KEY),
      ok: resolvePublishModelVersion(LEXICAL_INDEX_KEY) !== legacy,
    },
  ];
  return {
    ok: checks.every((c) => c.ok),
    legacy_model_version: legacy,
    checks,
  };
}

/**
 * inventoryTree — size / inode / nlink / mtime per member, by resolution.
 *
 * `unique_bytes` sums each DISTINCT INODE once. That is the number an operator
 * actually reclaims: the legacy tree carries two names for one inode
 * (hnsw.bin and hnsw.gen-3.bin), so a naive size sum overstates the reclaim by
 * the size of that member. `du -sk` on the same directory agrees with
 * unique_bytes, not with the naive sum — which is the cross-check.
 *
 * Read-only: readdirSync + lstatSync only. Never opens a member.
 *
 * @param {string} dir
 * @returns {{error: object|null, entries: Array, unique_bytes: number|null,
 *            naive_bytes: number|null, multi_link_inodes: number[]}}
 */
export function inventoryTree(dir) {
  let names;
  try {
    names = readdirSync(dir).sort();
  } catch (e) {
    return {
      error: {
        code: e && e.code === "ENOENT" ? "legacy_tree_absent" : "legacy_tree_unreadable",
        message: e && e.message ? e.message : String(e),
      },
      entries: [],
      unique_bytes: null,
      naive_bytes: null,
      multi_link_inodes: [],
    };
  }

  const entries = [];
  const seenInodes = new Set();
  const multiLink = new Set();
  let unique = 0;
  let naive = 0;

  for (const name of names) {
    const p = join(dir, name);
    let st;
    try {
      st = lstatSync(p);
    } catch (e) {
      return {
        error: {
          code: "legacy_tree_unreadable",
          message: `${name}: ${e && e.message ? e.message : String(e)}`,
        },
        entries,
        unique_bytes: null,
        naive_bytes: null,
        multi_link_inodes: [],
      };
    }
    const rec = {
      file: name,
      size: st.size,
      ino: st.ino,
      nlink: st.nlink,
      mtime: new Date(st.mtimeMs).toISOString(),
      mtime_ms: st.mtimeMs,
      is_file: st.isFile(),
    };
    entries.push(rec);
    if (!st.isFile()) continue;
    naive += st.size;
    if (!seenInodes.has(st.ino)) {
      seenInodes.add(st.ino);
      unique += st.size;
    }
    if (st.nlink > 1) multiLink.add(st.ino);
  }

  return {
    error: null,
    entries,
    unique_bytes: unique,
    naive_bytes: naive,
    multi_link_inodes: [...multiLink],
  };
}

/**
 * findLinksOutside — locate every OTHER name for the given inodes.
 *
 * Walks `scanRoot` without following symlinks and reports any path whose inode
 * is in `inodes` and which does not live under `treeDir`. A member with
 * st_nlink === 1 is never passed here: one link is already a proof, and a walk
 * cannot strengthen it.
 *
 * Unreadable subtrees are COUNTED, not swallowed: a permit that skipped half
 * the filesystem because of EACCES would be a false negative, so the count
 * rides in the envelope and a non-zero value is reported alongside the result.
 *
 * SCRATCH ROOTS ARE SKIPPED, AND THE SKIP IS COUNTED (e10)
 * -------------------------------------------------------
 * `scanRoot` defaults to MEMORY_ROOT, and before e10 this walk had NO skip
 * list at all: it descended `.git/`, `node_modules/`, the vendored node tree,
 * `local-embedder/.venv/`, `storage/`, and `.claude/worktrees/<id>/`. Two
 * separate costs, and they deserve to be told apart rather than blurred:
 *
 *   MEASURED, LIVE: the walk visited 52,103 files where the repo's real
 *   content is 3,557 — a 14.6x tax on every invocation, paid to lstat
 *   vendored and scratch trees that cannot contain an index member's second
 *   name in any interesting sense.
 *
 *   LATENT, NOT YET REALIZED: a hardlink inside a scratch root would be
 *   reported as a second name "outside the tree" and would REFUSE a
 *   legitimate deletion. Checked on this workspace 2026-08-20: zero files
 *   under `.claude/` have st_nlink > 1, so no such false refusal exists
 *   today. The e10 plan predicted one; the measurement says otherwise, and
 *   the measurement wins. What is real is the class — this walker had the
 *   same missing-exclusion shape as canonical-block-scan.mjs, whose version
 *   of it WAS live (75 false ERRORs) — so it is closed now rather than after
 *   someone hardlinks something into a worktree.
 *
 * The predicate is the SHARED one in scripts/_scan-exclusions.mjs, not a
 * second hand-rolled copy.
 *
 * THE COST, STATED RATHER THAN HIDDEN. Skipping a directory is exactly the
 * kind of narrowing that can turn a refusal into a false permit: a hardlink
 * living under a skipped root (`storage/`, say) would go unseen, and silence
 * would read as clearance. This program's rule is that absence is never a
 * verdict, so skipped roots are COUNTED and their names reported in the
 * envelope alongside `unreadable_dirs` — an operator reading a permit can see
 * precisely which subtrees were not searched and decide whether that matters
 * for their case. The skip is narrow (scratch/vendor/generated names only)
 * and never silent.
 */
export function findLinksOutside(scanRoot, treeDir, inodes) {
  const wanted = new Set(inodes);
  const outside = [];
  const inside = [];
  const skippedScratchDirs = [];
  let unreadableDirs = 0;
  let filesScanned = 0;
  if (wanted.size === 0) {
    return {
      outside,
      inside,
      unreadable_dirs: 0,
      files_scanned: 0,
      skipped_scratch_dirs: skippedScratchDirs,
    };
  }
  const treePrefix = resolve(treeDir) + "/";
  const stack = [resolve(scanRoot)];
  while (stack.length > 0) {
    const dir = stack.pop();
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      unreadableDirs += 1;
      continue;
    }
    for (const ent of ents) {
      const p = join(dir, ent.name);
      if (ent.isSymbolicLink()) continue; // a symlink is not a hardlink
      if (ent.isDirectory()) {
        if (isScratchDirName(ent.name)) {
          skippedScratchDirs.push(p);
          continue;
        }
        stack.push(p);
        continue;
      }
      if (!ent.isFile()) continue;
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      filesScanned += 1;
      if (!wanted.has(st.ino)) continue;
      if (p === resolve(treeDir) || p.startsWith(treePrefix)) inside.push(p);
      else outside.push(p);
    }
  }
  return {
    outside,
    inside,
    unreadable_dirs: unreadableDirs,
    files_scanned: filesScanned,
    skipped_scratch_dirs: skippedScratchDirs,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  let tree = null;
  let scanRoot = null;
  let windowMs = LEGACY_TREE_FRESHNESS_WINDOW_MS;

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      return { error: { code: "gate_help", message: "usage requested" }, usage: true };
    }
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg : arg.slice(0, eq);
    const val = eq === -1 ? null : arg.slice(eq + 1);
    if (val === null || val.length === 0) {
      return {
        error: {
          code: "gate_bad_arguments",
          message: `argument ${JSON.stringify(arg)} must be of the form --flag=value`,
        },
        usage: true,
      };
    }
    switch (key) {
      case "--tree":
        tree = val;
        break;
      case "--scan-root":
        scanRoot = val;
        break;
      case "--freshness-window-ms": {
        const n = Number(val);
        if (!Number.isFinite(n) || n < 0) {
          return {
            error: {
              code: "gate_bad_arguments",
              message: `--freshness-window-ms must be a finite, non-negative number of MILLISECONDS, got ${JSON.stringify(val)}`,
            },
            usage: true,
          };
        }
        windowMs = n;
        break;
      }
      default:
        return {
          error: {
            code: "gate_bad_arguments",
            message: `unknown argument ${JSON.stringify(key)}`,
          },
          usage: true,
        };
    }
  }

  // The legacy id comes from the module symbol. If the downstream code purge
  // has already removed it, there is no default tree to name and that is a bad
  // invocation, not a permit.
  if (tree === null) {
    if (
      typeof BM25_REBUILD_LEGACY_MODEL_VERSION !== "string" ||
      BM25_REBUILD_LEGACY_MODEL_VERSION.length === 0
    ) {
      return {
        error: {
          code: "gate_bad_arguments",
          message:
            "BM25_REBUILD_LEGACY_MODEL_VERSION is empty (the legacy model id has been purged); pass --tree=PATH explicitly",
        },
        usage: true,
      };
    }
    tree = join(MEMORY_ROOT, "indices", BM25_REBUILD_LEGACY_MODEL_VERSION);
  }

  return {
    error: null,
    tree: resolve(tree),
    scanRoot: resolve(scanRoot === null ? MEMORY_ROOT : scanRoot),
    windowMs,
  };
}

function emit(envelope, code) {
  process.stdout.write(JSON.stringify(envelope) + "\n");
  process.exitCode = code;
}

function baseEnvelope(fields) {
  return {
    verdict: "refuse",
    measured: false,
    tree_path: null,
    scan_root: null,
    legacy_model_version: BM25_REBUILD_LEGACY_MODEL_VERSION ?? null,
    error_code: null,
    error: null,
    ...fields,
  };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error !== null) {
    if (parsed.usage === true) process.stderr.write(USAGE + "\n");
    emit(
      baseEnvelope({ error_code: parsed.error.code, error: parsed.error.message }),
      2,
    );
    return;
  }

  const { tree, scanRoot, windowMs } = parsed;
  const common = { tree_path: tree, scan_root: scanRoot };

  // (1) RESURRECTION PREDICATES — cheapest, and the only failure that means
  // "deleting this achieves nothing", so it runs before anything touches disk.
  const resurrection = assessResurrectionPredicates();
  if (!resurrection.ok) {
    emit(
      baseEnvelope({
        ...common,
        resurrection,
        error_code: "legacy_tree_would_be_recreated",
        error:
          "a default (argument-less) writer still resolves the legacy tree; deleting it would be undone by the next rebuild",
      }),
      3,
    );
    return;
  }

  // (2) INVENTORY.
  const inventory = inventoryTree(tree);
  if (inventory.error !== null) {
    emit(
      baseEnvelope({
        ...common,
        resurrection,
        error_code: inventory.error.code,
        error: inventory.error.message,
      }),
      2,
    );
    return;
  }

  const { manifest, error: manifestError } = readActiveManifest(tree);
  if (manifestError !== null) {
    emit(
      baseEnvelope({
        ...common,
        resurrection,
        inventory,
        error_code: manifestError.code,
        error: manifestError.message,
      }),
      2,
    );
    return;
  }

  const manifestEntry =
    inventory.entries.find((e) => e.file === "index-manifest.json") ?? null;
  if (manifestEntry === null) {
    emit(
      baseEnvelope({
        ...common,
        resurrection,
        inventory,
        error_code: "index_manifest_absent",
        error:
          "no index-manifest.json in the tree: freshness cannot be measured, so this is unmeasurable rather than clear",
      }),
      2,
    );
    return;
  }

  // (3) OUTSIDE-HARDLINK SEARCH — only for inodes that actually have a second
  // link. nlink === 1 needs no walk.
  const links = findLinksOutside(scanRoot, tree, inventory.multi_link_inodes);
  if (links.outside.length > 0) {
    emit(
      baseEnvelope({
        ...common,
        resurrection,
        inventory,
        hardlinks: links,
        error_code: "member_hardlinked_outside_tree",
        error: `a member inode is also reachable at: ${links.outside.join(", ")} — deleting the tree would not free those bytes and would surprise that reader`,
      }),
      3,
    );
    return;
  }

  // (4) FRESHNESS.
  const freshness = evaluateFreshness({
    manifestMtimeMs: manifestEntry.mtime_ms,
    nowMs: Date.now(),
    windowMs,
  });
  if (freshness.fresh) {
    emit(
      baseEnvelope({
        ...common,
        resurrection,
        inventory,
        hardlinks: links,
        manifest_generation: manifest === null ? null : manifest.generation,
        manifest_created_at: manifest === null ? null : (manifest.created_at ?? null),
        freshness,
        error_code: "legacy_tree_recently_written",
        error: `index-manifest.json was written ${freshness.age_ms} ms ago, inside the ${freshness.window_ms} ms freshness window — something is still writing this tree`,
      }),
      3,
    );
    return;
  }

  // (5) COVERAGE — spawned, with no arguments, so its own defaults rule.
  const gate = spawnSync(process.execPath, [COVERAGE_GATE], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  let gateEnvelope = null;
  try {
    const line = String(gate.stdout ?? "").trim().split("\n").filter(Boolean).pop();
    gateEnvelope = line ? JSON.parse(line) : null;
  } catch {
    gateEnvelope = null;
  }

  const shared = {
    ...common,
    resurrection,
    inventory,
    hardlinks: links,
    manifest_generation: manifest === null ? null : manifest.generation,
    manifest_created_at: manifest === null ? null : (manifest.created_at ?? null),
    freshness,
    coverage_gate: {
      script: COVERAGE_GATE,
      exit_code: gate.status,
      envelope: gateEnvelope,
    },
  };

  if (gate.error != null || gate.status === null || gateEnvelope === null) {
    emit(
      baseEnvelope({
        ...shared,
        error_code: "coverage_gate_unmeasurable",
        error: `coverage gate produced no parseable envelope (status=${gate.status}, error=${gate.error ? gate.error.message : "none"})`,
      }),
      2,
    );
    return;
  }
  if (gate.status === 3) {
    emit(
      baseEnvelope({
        ...shared,
        measured: true,
        error_code: gateEnvelope.error_code ?? "bm25_coverage_below_floor",
        error: gateEnvelope.error ?? "coverage gate refused",
      }),
      3,
    );
    return;
  }
  if (gate.status !== 0 || gateEnvelope.verdict !== "permit") {
    emit(
      baseEnvelope({
        ...shared,
        error_code: gateEnvelope.error_code ?? "coverage_gate_unmeasurable",
        error: gateEnvelope.error ?? `coverage gate exited ${gate.status}`,
      }),
      2,
    );
    return;
  }

  emit(
    baseEnvelope({
      ...shared,
      verdict: "permit",
      measured: true,
      permits:
        "the legacy tree is not a default rebuild target, is not hardlinked outside itself, has not been written inside the freshness window, and the ACTIVE model's lexical coverage clears its floor. THIS IS NOT AN AUTHORIZATION TO DELETE.",
    }),
    0,
  );
}

// Run ONLY when executed directly. The pure predicates above are exported so
// the registered suite (mcp/test/rebuild-target-retarget.test.mjs) can drive
// them without a production path; an unguarded `main()` would spawn the
// coverage gate — against the LIVE tree — as a side effect of that import.
const INVOKED_DIRECTLY = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (INVOKED_DIRECTLY) {
  main();
}
