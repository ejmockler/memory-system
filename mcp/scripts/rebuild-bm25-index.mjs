#!/usr/bin/env node
// rebuild-bm25-index.mjs — WU-RR1-bm25-rebuild (+ L1 active-target retarget).
//
// One-shot, operator-initiated full rebuild of the BM25 inverted index from
// the canonical memory.jsonl ledger. Streams the ledger, tokenizes content,
// builds Bm25Index in memory, writes indices/<modelVersion>/bm25.json
// atomically (tmp + rename) via the generation publisher.
//
// PROBLEM (operator-facing):
//   The BM25 index on disk drifts behind the ledger when promote-time
//   incremental updates miss (torn write, transient FS error, hand-run
//   backfills that bypass distill-promote-fact). Recall Layer 1 returns
//   candidate_set_size=0 for queries whose terms exist only in the
//   un-indexed tail of the ledger. This script restores parity.
//
//   L1 addition: promote-time `bm25.add()` is the ONLY writer that has ever
//   touched the ACTIVE model's lexical index, because this CLI could not be
//   pointed at it. `resolveModelVersion()` used to substitute the gemini
//   default whenever no --model-version was passed and main() then handed
//   that value EXPLICITLY to the library, so the library never consulted its
//   own `_defaultRebuildModelVersion()` and the shipped env opt-in
//   MEMORY_BM25_REBUILD_TARGET_ACTIVE=1 was dead through this entry point.
//   That shadowing is removed below.
//
// CADENCE:
//   - Hand-run by an operator after a ledger-bulk-edit or a recovery.
//   - Invoked by the watermark daemon's idle tick when
//     CAPS.BM25_REBUILD_THRESHOLD facts have accumulated since the last
//     rebuild (separate wiring; this script is the manual entry point).
//
// USAGE:
//   node mcp/scripts/rebuild-bm25-index.mjs [--dry-run] [--model-version=ID]
//                                           [--target=active|legacy]
//                                           [--memory-root=DIR] [--coverage]
//                                           [--contextual] [--model-suffix=S]
//
//   --dry-run         : build the in-memory index but do NOT write to disk.
//                       Emits the counts envelope so the operator can sanity-
//                       check rows_indexed vs ledger size before committing.
//   --model-version=X : override the embedding-model id (path component).
//                       Highest-precedence model selector (see RESOLUTION
//                       ORDER below).
//   --target=active   : build into CAPS.ACTIVE_EMBED_MODEL_VERSION.
//   --target=legacy   : build into CAPS.GEMINI_EMBEDDING_MODEL_DEFAULT.
//                       Any other --target value is rejected (exit 2).
//   --memory-root=DIR : OUTPUT CONTAINMENT. Redirect every index/storage write
//                       under DIR by pinning MEMORY_ROOT and STORAGE_BASE_DIR
//                       BEFORE lib/config.js is evaluated, while LEDGERS_BASE_DIR
//                       stays pinned at the PRE-OVERRIDE ledgers directory so the
//                       build still streams the production ledger READ-ONLY.
//                       (Without that re-pin config.js would derive the ledgers
//                       dir from DIR and the build would index zero rows while
//                       reporting success.)
//   --coverage        : after a non-dry-run build, measure the built index with
//                       probeBm25Coverage() and merge indexed_docs /
//                       eligible_rows / coverage_pct / numerator_unit /
//                       denominator_unit / coverage_pct_unit into the envelope.
//                       coverage_pct is a PERCENT in [0,100+], emitted
//                       UNCLAMPED and untransformed. On --dry-run those keys
//                       are null — never fabricated.
//   --contextual      : N5 — build the CONTEXTUAL arm: concatenate the
//                       deterministic context prefix (buildContextPrefix) onto
//                       each fact before tokenization, loading the backward
//                       conversation-index for a real thread label. WITHOUT
//                       flipping the global CAPS.CONTEXTUAL_BM25_ENABLED. The
//                       output tree is forced to <model>-contextual (via the
//                       default --model-suffix=-contextual) so the baseline
//                       bm25.json is never clobbered. This is the on-disk
//                       materialization the contextual-eval A/B needs.
//   --model-suffix=S  : suffix appended to the model-version path component
//                       (default "-contextual" when --contextual is set, else
//                       ""). Lets an operator build into a distinct A/B tree.
//
// MODEL RESOLUTION ORDER (highest first) — the CLI no longer shadows the
// library's own default. Steps 1-2 are resolveModelVersion() below; step 3 is
// _defaultRebuildModelVersion() in lib/recall/bm25-rebuild.js, whose four
// branches are reproduced here in ITS order (every flag is compared EXACTLY
// against the string "1" — "true", "yes" and "0" are all falsey to it):
//   1. --model-version=ID              : explicit, wins over everything.
//   2. --target=active|legacy          : CAPS.ACTIVE_EMBED_MODEL_VERSION /
//                                        CAPS.GEMINI_EMBEDDING_MODEL_DEFAULT.
//   3. _defaultRebuildModelVersion(), read at CALL TIME:
//        a. MEMORY_BM25_REBUILD_TARGET_LEGACY=1 -> the legacy Gemini tree
//           (BM25_REBUILD_LEGACY_MODEL_VERSION). The branch additionally
//           requires that symbol to be a non-empty string, so the eventual
//           CAPS-key purge falls THROUGH to (b)-(d) rather than emitting an
//           empty path component. This branch is FIRST — it is the escape
//           hatch, and it outranks (b) even when both flags are set.
//        b. MEMORY_BM25_REBUILD_TARGET_ACTIVE=1 -> CAPS.ACTIVE_EMBED_MODEL_VERSION.
//        c. MEMORY_BM25_MODEL_NEUTRAL=1         -> the model-neutral `_lexical`
//           projection key.
//        d. (default)                           -> CAPS.ACTIVE_EMBED_MODEL_VERSION.
//   l11 flipped (d): with every flag unset an argument-less run resolves the
//   ACTIVE model, NOT the gemini default. The legacy tree is the opt-in now.
//   Whatever step 1-3 produces then gets the --model-suffix / --contextual
//   suffix appended (unchanged semantics) — note the suffix is applied AFTER
//   this resolution, so `_lexical` + "-contextual" is a plain `_lexical-
//   contextual` TREE and is not redirected by the projection rule below.
//
// LOGICAL TARGET vs PHYSICAL PUBLISH TARGET:
//   `_lexical` is a PROJECTION, not a tree. resolvePublishModelVersion()
//   (lib/recall/bm25-rebuild.js) maps it onto CAPS.ACTIVE_EMBED_MODEL_VERSION:
//   the rebuild publishes a generation THROUGH the ACTIVE model's tree and
//   then activates an immutable `_lexical` member from it. Every other target
//   publishes into its own name. So the model_version an operator asks for is
//   NOT always the directory that gets written.
//
// LIVE-TREE WRITE GUARD:
//   A full ACTIVE-tree rebuild is an operator action against a TEMP root,
//   never an accidental in-place publish over the index the running queryd is
//   serving. So: when the PHYSICAL publish target — resolvePublishModelVersion
//   (resolved model) — is CAPS.ACTIVE_EMBED_MODEL_VERSION and this is not a
//   --dry-run, the script REFUSES (exit 2, nothing written) unless
//   --memory-root points somewhere other than the production root. Testing the
//   LOGICAL name here is what let `_lexical` publish over the served index; the
//   library carries the same refusal at its own publish site, so a caller that
//   bypasses this CLI still hits it (Bm25LiveTreePublishError).
//
//   r4: "somewhere other than the production root" is decided by the library's
//   isLiveIndexRoot() — IMPORTED, never re-derived — which compares DIRECTORY
//   IDENTITY (dev+ino) on both sides for the `indices` directory that actually
//   gets written. Two path strings that name one directory therefore compare
//   equal whatever produced the second spelling, so a `--memory-root` that is a
//   symlink to the live root, a case-alias of it on a case-insensitive volume,
//   or a root whose `indices` child is a symlink into it, is refused as well.
//
//   r4 also extends the guard past the served tree: a NON-served target under
//   the live root (a mistyped --model-version, `_lexical-contextual`, the
//   legacy model) creates a SIBLING directory the live system reads, and is
//   refused (exit 2, nothing built) unless the operator acknowledges the
//   PHYSICAL tree with --allow-live-tree=<model-version>. There is deliberately
//   no environment variable equivalent for either half.
//
//   r5: the served refusal is NOT gated on --memory-root being absent. The
//   DESTINATION measurement — isServedIndexTree(<root>, publishTarget), dev+ino
//   of `<root>/indices/<publishTarget>` — refuses on its own, whatever
//   arguments produced the root. The `--memory-root was not supplied, or the
//   root is live` term survives, conjoined ONLY with the model-NAME compare,
//   because dropping it there would refuse every legitimate
//   `--memory-root=<tempdir> --target=active` — the armed path this script
//   exists to offer. MEASURED, stand-in live root under TMP:
//   `--target=active --memory-root=<other>` with `<other>/indices/<ACTIVE>`
//   symlinked at the seeded served directory ran exit 0 / empty stderr /
//   sentinel 35f8339f… -> df23aa87… / bm25.gen-0.json created BEFORE, and
//   exit 2 / /refusing to publish/ / empty stdout / byte-identical sentinel
//   AFTER, on a run that also recorded isServedIndexTree(<other>,<ACTIVE>)
//   ===true and isLiveIndexRoot(<other>)===false. What r5 does NOT close is
//   the sibling spelling — `<other>/indices/<typo>` symlinked at
//   `<live>/indices/<typo>` — measured permit BEFORE and permit AFTER; it is
//   filed as a residual at the library guard, not claimed here.
//
//   r4-b1-guard-residuals: "the served tree" is decided by a DISJUNCTION —
//   publishTarget === CAPS.ACTIVE_EMBED_MODEL_VERSION OR isServedIndexTree(),
//   which measures dev+ino of the DESTINATION `<root>/indices/<publishTarget>`.
//   Both terms are imported from the library, never re-derived. The name term
//   alone was the root-level defect one level down — a model version is a PATH
//   COMPONENT, so `QWEN3-EMBEDDING-8B-FP16`, a symlinked model directory,
//   `<active>/../<active>` and `<active>/` all name the served directory while
//   failing the string compare; each was MEASURED being routed to the sibling
//   arm and, once acknowledged with --allow-live-tree=<that same spelling>,
//   publishing over a seeded live bm25.json at exit 0 with empty stderr. So the
//   acknowledgement flag's reach is bounded by a measurement of where the write
//   LANDS, not by the spelling the operator typed. What that does not cover is
//   listed at the library guard (CAPS as a proxy for what queryd serves; the
//   pre-write TOCTOU window; a traversal target that leaves indices/ entirely).
//
// OUTPUT (one JSON line to stdout):
//   {
//     ledger_path, model_version, memory_root, bm25_path,
//     rows_total, rows_indexed, rows_skipped,
//     total_lines, parsed_lines,
//     wrote_index, bytes_written, duration_ms,
//     // --coverage only (null on --dry-run):
//     indexed_docs, eligible_rows, coverage_pct,
//     numerator_unit, denominator_unit, coverage_pct_unit, coverage_error
//   }
//
// EXIT CODES:
//   0 — rebuild succeeded (or --dry-run completed). The new bm25.json is
//       on disk and the next index-cache load will pick it up.
//   1 — writer failure (mkdir / write / rename threw). The OLD bm25.json
//       is intact on disk (atomic write went via .tmp + rename); recall
//       continues to serve from the stale index until the next rebuild.
//   2 — bad invocation: unknown arg, bad --target value, or the live-tree
//       write guard refusing an active-target in-place publish. NOTHING was
//       built and nothing was written.
//   3 — the index WAS built and written, but --coverage measurement failed
//       (Bm25CoverageProbeError: probe_index_unreadable,
//       probe_ledger_no_eligible_rows, ...). The envelope still prints, with
//       the coverage keys null plus `coverage_error`. Distinct from 1 on
//       purpose: 1 means no index was written, 3 means only the measurement
//       is missing.

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// NOTE: lib/recall/bm25-rebuild.js and lib/validation.js are deliberately NOT
// imported at the top level. Both transitively evaluate lib/config.js, which
// FREEZES MEMORY_ROOT / STORAGE_DIR / LEDGERS_DIR into module-level consts at
// evaluation time. A static import here would run that before the
// --memory-root env block below, silently voiding containment. They are loaded
// with `await import(...)` after the env is pinned.

const USAGE =
  "usage: rebuild-bm25-index.mjs [--dry-run] [--model-version=ID] " +
  "[--target=active|legacy] [--memory-root=DIR] [--coverage] " +
  "[--contextual] [--model-suffix=S] [--allow-live-tree=PHYSICAL_MODEL]\n";

const TARGET_ACTIVE = "active";
const TARGET_LEGACY = "legacy";

/**
 * parseArgs — returns the parsed options, or null when the process should stop
 * (help / bad invocation). On the null path `process.exitCode` is already set
 * and the reason is on stderr; we return instead of calling process.exit() so
 * the stream flushes before the process ends.
 */
function parseArgs(argv) {
  const opts = {
    dryRun: false,
    modelVersion: undefined,
    target: undefined,
    memoryRoot: undefined,
    coverage: false,
    contextual: false,
    modelSuffix: undefined,
    allowLiveTree: undefined,
  };
  for (const a of argv.slice(2)) {
    if (a === "--dry-run") opts.dryRun = true;
    else if (a.startsWith("--model-version=")) {
      opts.modelVersion = a.slice("--model-version=".length);
    } else if (a.startsWith("--target=")) {
      const t = a.slice("--target=".length);
      if (t !== TARGET_ACTIVE && t !== TARGET_LEGACY) {
        process.stderr.write(
          `rebuild-bm25-index: --target must be "${TARGET_ACTIVE}" or ` +
            `"${TARGET_LEGACY}", got ${JSON.stringify(t)}\n`,
        );
        process.exitCode = 2;
        return null;
      }
      opts.target = t;
    } else if (a.startsWith("--memory-root=")) {
      opts.memoryRoot = a.slice("--memory-root=".length);
      if (opts.memoryRoot.length === 0) {
        process.stderr.write(
          "rebuild-bm25-index: --memory-root= requires a directory\n",
        );
        process.exitCode = 2;
        return null;
      }
    } else if (a === "--coverage") {
      opts.coverage = true;
    } else if (a === "--contextual") {
      opts.contextual = true;
    } else if (a.startsWith("--model-suffix=")) {
      opts.modelSuffix = a.slice("--model-suffix=".length);
    } else if (a.startsWith("--allow-live-tree=")) {
      opts.allowLiveTree = a.slice("--allow-live-tree=".length);
      if (opts.allowLiveTree.length === 0) {
        process.stderr.write(
          "rebuild-bm25-index: --allow-live-tree= requires the PHYSICAL " +
            "model-version tree you intend to write\n",
        );
        process.exitCode = 2;
        return null;
      }
    } else if (a === "--help" || a === "-h") {
      process.stderr.write(USAGE);
      process.exitCode = 0;
      return null;
    } else {
      process.stderr.write(`rebuild-bm25-index: unknown arg ${a}\n`);
      process.exitCode = 2;
      return null;
    }
  }
  return opts;
}

// resolveModelVersion — compute the output-tree path component.
//
// The BASE model follows the documented precedence (explicit > --target >
// library default). Step 3 DELEGATES to the library's
// `_defaultRebuildModelVersion()` instead of substituting a constant, so its
// call-time env opt-ins (see the four branches in the header block) are live
// through this CLI. With every flag unset that helper returns
// CAPS.ACTIVE_EMBED_MODEL_VERSION — l11 moved the argument-less default off the
// legacy Gemini tree, and the legacy tree is now reached only by asking for it
// by name (--target=legacy or MEMORY_BM25_REBUILD_TARGET_LEGACY=1).
//
// The SUFFIX logic is unchanged: N5's --contextual forces a "-contextual"
// suffix (overridable via --model-suffix) so the contextual arm builds into
// indices/<model>-contextual/ and NEVER clobbers the baseline bm25.json.
function resolveModelVersion(opts, deps) {
  const { CAPS, _defaultRebuildModelVersion } = deps;
  let base;
  if (typeof opts.modelVersion === "string" && opts.modelVersion.length > 0) {
    base = opts.modelVersion; // (1) explicit wins over everything
  } else if (opts.target === TARGET_ACTIVE) {
    base = CAPS.ACTIVE_EMBED_MODEL_VERSION; // (2) --target
  } else if (opts.target === TARGET_LEGACY) {
    base = CAPS.GEMINI_EMBEDDING_MODEL_DEFAULT;
  } else {
    base = _defaultRebuildModelVersion(); // (3) library default, call-time env
  }
  let suffix = "";
  if (typeof opts.modelSuffix === "string") suffix = opts.modelSuffix;
  else if (opts.contextual) suffix = "-contextual";
  return suffix.length > 0 ? `${base}${suffix}` : base;
}

/**
 * applyOutputContainment — pin the OUTPUT root without moving the INPUT ledger.
 *
 * Captures the ledgers directory the process would have used BEFORE any
 * mutation, then re-pins LEDGERS_BASE_DIR to exactly that value after
 * MEMORY_ROOT moves. config.js derives LEDGERS_DIR from MEMORY_ROOT when
 * LEDGERS_BASE_DIR is unset, so skipping the re-pin would point the build at
 * <root>/ledgers/memory.jsonl — a missing file that streams as zero rows and
 * reports success.
 *
 * Returns the effective output root (resolved absolute path).
 */
function applyOutputContainment(memoryRootArg) {
  // Same default as lib/config.js (CHECKOUT_ROOT: the checkout that contains
  // mcp/), re-derived from this file's own location because config.js must
  // not be evaluated before the env pins below. Unset MEMORY_ROOT therefore
  // reports exactly the root the library writes to.
  const preMemoryRoot =
    process.env.MEMORY_ROOT || resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const preLedgersDir = process.env.LEDGERS_BASE_DIR || join(preMemoryRoot, "ledgers");
  if (memoryRootArg === undefined) return resolve(preMemoryRoot);
  const root = resolve(memoryRootArg);
  process.env.MEMORY_ROOT = root;
  process.env.STORAGE_BASE_DIR = join(root, "storage");
  process.env.LEDGERS_BASE_DIR = preLedgersDir; // production ledger, READ-ONLY
  return root;
}

/**
 * ensureOutputDirs — the mkdir half of containment, split out of
 * applyOutputContainment (r4) and invoked ONLY after every write guard has
 * passed.
 *
 * Creating these eagerly meant a REFUSED `--memory-root=<symlink-to-live>` run
 * still left a `storage/` directory under the sacred root: a write performed
 * during a refusal. The guards are pure reads and must run first; a refusal now
 * leaves the root it refused byte-identical.
 */
function ensureOutputDirs(memoryRootArg, root) {
  if (memoryRootArg === undefined) return;
  mkdirSync(join(root, "indices"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "storage"), { recursive: true, mode: 0o700 });
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts === null) return;

  // --- env containment FIRST: nothing that reaches lib/config.js may have
  // been evaluated before this line (see the import note at the top). -------
  const memoryRoot = applyOutputContainment(opts.memoryRoot);

  const {
    rebuildBm25IndexFromLedger,
    _defaultRebuildModelVersion,
    resolvePublishModelVersion,
    isLiveIndexRoot,
    isServedIndexTree,
  } = await import("../lib/recall/bm25-rebuild.js");
  const { CAPS } = await import("../lib/validation.js");

  const modelVersion = resolveModelVersion(opts, {
    CAPS,
    _defaultRebuildModelVersion,
  });

  // --- live-tree write guard (before any build, so nothing is written) -----
  // The subject of this guard is the tree a publish LANDS in, not the name the
  // operator typed. `_lexical` names a projection, and the library redirects it
  // onto the ACTIVE model's tree before publishing, so a logical-name test
  // waved it straight through and clobbered the served index. resolvePublish-
  // ModelVersion is the library's own redirect — imported, never re-derived.
  // r4 — `memoryRoot === LIVE_ROOT` was a lexical string compare, so a symlink
  // or alias walked past it. isLiveIndexRoot compares DIRECTORY IDENTITY
  // (dev+ino) on both sides for the indices/ directory that is actually
  // written. IMPORTED from the library, never re-derived: a second copy of this
  // rule is how b1 happened.
  // r5 — the `opts.memoryRoot === undefined` term STAYS, but it now conjoins
  // ONLY with the model-NAME compare. Dropping it entirely would refuse every
  // legitimate `--memory-root=<tempdir> --target=active`, which is the armed
  // path the registered case "b1 armed — --target=active --memory-root=<tmp>
  // still publishes" pins; keeping it over the whole disjunction is what made
  // the DESTINATION measurement inert on exactly the runs it was added for.
  // The identity measurement is therefore UNCONDITIONAL: it refuses on its own,
  // regardless of whether an argument was supplied or the root is live. This is
  // monotone tightening — the only verdicts that move are
  // {destinationIsServed:true, memoryRootPresent:true, liveTree:false,
  // dryRun:false}, permit -> refuse, enumerated as an executable case in
  // section 5g of mcp/test/bm25-full-rebuild.test.mjs.
  // r4-b1-guard-residuals — "does this land in the SERVED tree?" is a
  // DISJUNCTION of the model-name compare and isServedIndexTree, which measures
  // the DESTINATION `<root>/indices/<publishTarget>` by dev+ino. The name
  // compare alone was the same defect one level down from the root compare: a
  // model version is a PATH COMPONENT, so a case-variant, a symlinked model
  // directory, `<active>/../<active>` and `<active>/` were each measured being
  // routed to the SIBLING arm and published over a seeded live bm25.json at
  // exit 0. The name term STAYS as a disjunct — dropping it would let
  // --allow-live-tree=<ACTIVE> back in whenever isLiveIndexRoot returned true
  // out of its fail-closed catch while the destination measurement succeeded.
  // IMPORTED, never re-derived: this file contains no dev/ino comparison and no
  // containment rule of its own, because a second copy of that rule is how b1
  // happened. The CLI must refuse at its OWN layer rather than lean on the
  // library throw — ensureOutputDirs runs after these guards but BEFORE
  // rebuildBm25IndexFromLedger, so a CLI that waved an aliased target through
  // would mkdir indices/ and storage/ under the live root during a refusal,
  // re-opening the leak r4 closed.
  const publishTarget = resolvePublishModelVersion(modelVersion);
  // r5 — the two disjuncts are named SEPARATELY because only one of them may be
  // subordinated to the argument-presence proxy below.
  const destinationIsServed = isServedIndexTree(memoryRoot, publishTarget);
  const targetsServedByName = publishTarget === CAPS.ACTIVE_EMBED_MODEL_VERSION;
  const targetsServed = destinationIsServed || targetsServedByName;
  const liveTree = isLiveIndexRoot(memoryRoot);
  const uncontained = opts.memoryRoot === undefined || liveTree;
  if (
    !opts.dryRun &&
    (destinationIsServed || (targetsServedByName && uncontained))
  ) {
    const targetNote =
      publishTarget !== CAPS.ACTIVE_EMBED_MODEL_VERSION
        ? `(publishes into indices/${publishTarget}, which IS the served ` +
          `${CAPS.ACTIVE_EMBED_MODEL_VERSION} directory)`
        : publishTarget === modelVersion
          ? "(the ACTIVE embedding model)"
          : `(publishes into ${publishTarget}, the ACTIVE embedding model)`;
    // r5 — THE CLOSING ADVICE MUST BE TRUE OF THE RUN THAT TRIGGERED IT. The
    // historical sentence tells the operator to re-run with
    // --memory-root=<TEMPDIR>. On the branch this node newly made reachable —
    // destinationIsServed while the root is contained and not live — the
    // operator ALREADY passed a temp root; what names the served directory is
    // the aliasing `indices/<model-version>` child UNDER that root, so the old
    // sentence would be false advice. MEASURED: `--target=active
    // --memory-root=<other>` with `<other>/indices/<ACTIVE>` symlinked at a
    // seeded stand-in served directory ran exit 0 / empty stderr / sentinel
    // 35f8339f… -> df23aa87… with bm25.gen-0.json created before this change,
    // and exits 2 with this sentence after it.
    const remedy =
      destinationIsServed && !uncontained
        ? `${join(memoryRoot, "indices", publishTarget)} IS the served ` +
          `${CAPS.ACTIVE_EMBED_MODEL_VERSION} directory by directory identity, ` +
          `while ${memoryRoot} is NOT the live root — so re-pointing ` +
          "--memory-root is not the fix; the aliasing indices/ child under it " +
          "is. Repoint or remove that child, or add --dry-run."
        : "Re-run with --memory-root=<TEMPDIR> (outside the live tree), or " +
          "add --dry-run.";
    process.stderr.write(
      `rebuild-bm25-index: refusing to publish model_version=${modelVersion} ` +
        `${targetNote} into ${memoryRoot}. A full active-tree ` +
        "rebuild is an operator action against a temp root, never an in-place " +
        `publish over the index the running queryd serves. ${remedy}\n`,
    );
    process.exitCode = 2;
    return;
  }

  // --- r4: the SIBLING half of the same guard --------------------------------
  // A non-active target under the live root does not clobber the served index,
  // but it does create a directory the live system reads —
  // `indices/qwen3-embedding-8b-fp16-typo/` is what a fat-fingered
  // --model-version produced, silently, at exit 0. Default is REFUSE.
  //
  // THE ARGUED DECISION: refusal is unlocked by exactly one explicit,
  // human-typed acknowledgement — --allow-live-tree=<PHYSICAL model-version> —
  // and never by an environment variable. The value must equal the PHYSICAL
  // publish target, not the logical name, so a typo cannot survive being typed
  // twice under a flag that names the tree on disk.
  //
  // WHAT KEEPS THE FLAG OFF THE SERVED TREE, mechanism instead of an absolute:
  // the served-tree refusal above fires first, does not consult this flag, and
  // decides with targetsServed — the model-name compare OR a dev+ino
  // measurement of the destination directory. While that decision was the NAME
  // ALONE, this flag DID reach the served tree: `--allow-live-tree=QWEN3-
  // EMBEDDING-8B-FP16` (and the symlink / `<active>/..` / trailing-slash
  // spellings) were each measured publishing over a seeded live bm25.json at
  // exit 0 with empty stderr. What the measurement does NOT cover is named at
  // the library guard's carried-limitation list — chiefly that ACTIVE_EMBED_-
  // MODEL_VERSION is a proxy for what queryd serves rather than a reading of
  // it, and that the check is a pure read taken before the write.
  //
  // COST of keeping a deliberate path at all (rather than blanket refusal): one
  // more flag, and an operator who types it twice can still write a sibling
  // tree beside the served index. It is kept because the consumer is MEASURED
  // alive, not assumed: mcp/scripts/run-contextual-eval.mjs takes its root
  // from lib/config.js MEMORY_ROOT and reads
  // `indices/<model>-contextual/bm25.json`; it is driven by
  // run-contextual-eval-ab.mjs, which a registered suite
  // (mcp/test/synthesis/contextual-dense-embed.test.mjs) exercises. Blanket
  // refusal would leave that arm with no one-step path to build what it reads.
  if (!targetsServed && !opts.dryRun && liveTree) {
    if (opts.allowLiveTree === undefined) {
      const siblingNote =
        publishTarget === modelVersion ? "" : `(publishes into ${publishTarget}) `;
      process.stderr.write(
        `rebuild-bm25-index: refusing to publish model_version=${modelVersion} ` +
          `${siblingNote}into the live tree at ` +
          `${memoryRoot}. It is not the ACTIVE embedding model, so this would ` +
          "create a SIBLING index tree beside the one queryd serves — which is " +
          "what a mistyped --model-version looks like. Re-run with " +
          "--memory-root=<TEMPDIR>, add --dry-run, or acknowledge the physical " +
          `tree explicitly with --allow-live-tree=${publishTarget}.\n`,
      );
      process.exitCode = 2;
      return;
    }
    if (opts.allowLiveTree !== publishTarget) {
      process.stderr.write(
        `rebuild-bm25-index: --allow-live-tree=${opts.allowLiveTree} does not ` +
          `match the physical publish target ${publishTarget} (from ` +
          `model_version=${modelVersion}). The acknowledgement must name the ` +
          "tree that is actually written, exactly. Nothing was built.\n",
      );
      process.exitCode = 2;
      return;
    }
  }

  // Every write guard has passed; only now may this process create directories.
  ensureOutputDirs(opts.memoryRoot, memoryRoot);

  let result;
  try {
    result = rebuildBm25IndexFromLedger({
      dryRun: opts.dryRun,
      modelVersion,
      // N5 — pass the contextual toggle explicitly so the rebuild concatenates
      // the prefix + loads the conversation-index, WITHOUT depending on the
      // global CAPS.CONTEXTUAL_BM25_ENABLED (still default OFF). The library
      // resolves the conversation-index join from the live cache itself.
      contextualPrefix: opts.contextual === true,
      // r4 — only ever true on the exact-match branch above. The library
      // re-decides the served-tree question with the SAME imported predicate
      // before it looks at this opt, so a value that survives this CLI is
      // checked a second time rather than trusted; `!targetsServed` is what
      // keeps an aliased destination out, and r4-b1-guard-residuals measured
      // that the NAME compare alone did not.
      allowLiveTreeSiblingPublish:
        !targetsServed && liveTree && opts.allowLiveTree === publishTarget,
    });
  } catch (err) {
    process.stderr.write(
      `rebuild-bm25-index: rebuild failed: ${
        err && err.message ? err.message : String(err)
      }\n`,
    );
    process.exitCode = 1;
    return;
  }

  // --- optional measurement -----------------------------------------------
  // Reuse probeBm25Coverage: it is the ONE counter whose units are stamped
  // (distinct_doc_ids over eligible_lines) and whose coverage_pct is a PERCENT.
  // mcp/lib/synthesis/coverage-probe.js is deliberately NOT used here — its
  // pct() returns a FRACTION.
  const envelope = { ...result, memory_root: memoryRoot };
  if (opts.coverage) {
    const nullCoverage = {
      indexed_docs: null,
      eligible_rows: null,
      coverage_pct: null,
      numerator_unit: null,
      denominator_unit: null,
      coverage_pct_unit: null,
      coverage_error: null,
    };
    if (opts.dryRun || result.wrote_index !== true || result.bm25_path == null) {
      // A dry run measured nothing. Emitting zeros here would be a fabricated
      // measurement; nulls are the honest report.
      Object.assign(envelope, nullCoverage);
    } else {
      try {
        const { probeBm25Coverage } = await import(
          "../lib/recall/bm25-coverage-probe.js"
        );
        const cov = probeBm25Coverage({
          indexPath: result.bm25_path,
          ledgerPath: result.ledger_path,
        });
        Object.assign(envelope, {
          indexed_docs: cov.indexed_docs,
          eligible_rows: cov.eligible_rows,
          coverage_pct: cov.coverage_pct, // PERCENT, unclamped, untransformed
          numerator_unit: cov.numerator_unit,
          denominator_unit: cov.denominator_unit,
          coverage_pct_unit: cov.coverage_pct_unit,
          coverage_error: null,
        });
      } catch (err) {
        const code = err && err.code ? err.code : null;
        Object.assign(envelope, nullCoverage, {
          coverage_error: `${code === null ? "" : code + ": "}${
            err && err.message ? err.message : String(err)
          }`,
        });
        // The build SUCCEEDED; only the measurement failed. Never swallow that
        // into exit 0, and never report exit 1 (which means "no index written").
        process.stdout.write(JSON.stringify(envelope) + "\n");
        process.exitCode = 3;
        return;
      }
    }
  }

  // NDJSON-style single line on stdout so operators can pipe to jq.
  process.stdout.write(JSON.stringify(envelope) + "\n");
  process.exitCode = 0;
}

await main();
