// bm25-full-rebuild.test.mjs — L1: the one-shot CLI must be pointable at the
// ACTIVE index tree, must be containable to a scratch output root, and must be
// able to MEASURE what it built.
//
// Hermetic: every root, ledger and index this file creates lives under
// TMP_ROOT (mkdtemp), removed on process exit. The CLI is spawned with
// process.execPath and an EXPLICIT env object — never bare process.env — so an
// ambient MEMORY_BM25_* flag in the operator's shell cannot decide a case.
//
// NEVER points a rebuild at the production ledger. Fixtures are tens of rows.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-bm25-full-rebuild-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");
delete process.env.MEMORY_BM25_MODEL_NEUTRAL;
delete process.env.MEMORY_BM25_REBUILD_TARGET_ACTIVE;
// l11 — the legacy target became an explicit opt-in; clear it like its sibling.
delete process.env.MEMORY_BM25_REBUILD_TARGET_LEGACY;
delete process.env.MEMORY_BM25_REBUILD_OBJECT_ENTITIES;

for (const dir of [
  process.env.POLICY_BASE_DIR,
  process.env.STORAGE_BASE_DIR,
  process.env.LEDGERS_BASE_DIR,
  join(MEMORY_ROOT, "indices"),
]) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort fixture cleanup
  }
});

const { CAPS } = await import("../lib/validation.js");
// b1 — the model-neutral projection key, imported rather than spelled, so the
// physical-target assertions below cannot drift from the library's own name.
// r4 — the model-neutral ENV flag's name is imported for the same reason: the
// `_lexical-contextual` residual is driven by MEMORY_BM25_MODEL_NEUTRAL=1 plus
// --contextual, and spelling either as a literal lets the case drift.
const { LEXICAL_INDEX_KEY, BM25_MODEL_NEUTRAL_FLAG } = await import(
  "../lib/recall/bm25-projection.js"
);

const ACTIVE_MODEL = CAPS.ACTIVE_EMBED_MODEL_VERSION;
const LEGACY_MODEL = CAPS.GEMINI_EMBEDDING_MODEL_DEFAULT;

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(HERE, "..", "scripts", "rebuild-bm25-index.mjs");
// b1 — the LIBRARY seam. lib/config.js freezes MEMORY_ROOT into a module-level
// const at evaluation time, so a live-root library call cannot be exercised
// in-process from this file (its own MEMORY_ROOT is already pinned at the top).
// Every library-seam case below therefore runs in a fresh child.
const LIB_URL = pathToFileURL(
  join(HERE, "..", "lib", "recall", "bm25-rebuild.js"),
).href;

/** Base env for every spawn: hermetic roots, all BM25 opt-ins explicitly off. */
function baseEnv(overrides = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: join(TMP_ROOT, "fake-home"),
    MEMORY_ROOT,
    POLICY_BASE_DIR: process.env.POLICY_BASE_DIR,
    STORAGE_BASE_DIR: process.env.STORAGE_BASE_DIR,
    LEDGERS_BASE_DIR: process.env.LEDGERS_BASE_DIR,
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

// r4-b1 — `cwd` is optional and defaults to this process's, so every existing
// call site is unchanged; only the cwd-relative --memory-root case sets it.
function runCli(args, env, cwd) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    env,
    encoding: "utf8",
    ...(cwd === undefined ? {} : { cwd }),
  });
}

/**
 * runNodeModule — runCli's sibling for the LIBRARY seam: evaluate an ESM
 * snippet in a fresh child under an EXPLICIT env, so lib/config.js freezes the
 * MEMORY_ROOT this case wants rather than the one this file pinned at import.
 */
function runNodeModule(src, env) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", src], {
    env,
    encoding: "utf8",
  });
}

function envelopeOf(proc) {
  const out = (proc.stdout || "").trim();
  assert.ok(out.length > 0, `CLI stdout non-empty (stderr: ${proc.stderr})`);
  return JSON.parse(out);
}

/** Tiny all-eligible fixture ledger: every row has a non-empty id + content. */
function writeFixtureLedger(path, count) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({
      id: `mem_l1_${String(i).padStart(3, "0")}`,
      kind: "fact",
      content: `fixture row ${i} alpha_${i % 7} shared lexical payload`,
      created_at: `2026-08-15T00:${String(i % 60).padStart(2, "0")}:00.000Z`,
    });
  }
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return count;
}

// The default ledger the hermetic MEMORY_ROOT resolves to (config.js
// memoryLedgerPath() = LEDGERS_DIR/memory.jsonl).
const DEFAULT_LEDGER = join(process.env.LEDGERS_BASE_DIR, "memory.jsonl");
const FIXTURE_ROWS = writeFixtureLedger(DEFAULT_LEDGER, 10);

/** Files (recursively) under a directory, relative + sorted. [] when absent. */
function treeListing(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d, prefix) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const rel = prefix.length === 0 ? name.name : `${prefix}/${name.name}`;
      if (name.isDirectory()) walk(join(d, name.name), rel);
      else out.push(rel);
    }
  };
  walk(dir, "");
  return out.sort();
}

/** Files (recursively) under an indices/ tree, sorted. [] when absent. */
function indexTreeListing(root) {
  return treeListing(join(root, "indices"));
}

function sha256Of(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// b1 — the sentinel's contents are irrelevant; only its BYTES are evidence.
// This file is UNTRACKED, so `git diff` proves nothing about it and a digest
// is the only honest proof that a live bm25.json survived a refused publish.
const SENTINEL_BYTES = '{"__b1_live_tree_sentinel__":"do-not-clobber"}\n';

/**
 * seedSentinel — build a FAKE live tree under a temp home and plant a known
 * bm25.json where the ACTIVE model's served index lives:
 *   <fakeHome>/memory-system/indices/<ACTIVE_MODEL>/bm25.json
 * Returns the paths plus the seed digest. A publish through publishGeneration
 * demotes this file to bm25.gen-0.json and writes a new bm25.json, so BOTH the
 * digest and the absence of bm25.gen-0.json are load-bearing.
 */
function seedSentinel(fakeHome) {
  mkdirSync(fakeHome, { recursive: true, mode: 0o700 });
  const root = join(fakeHome, "memory-system");
  const dir = join(root, "indices", ACTIVE_MODEL);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const bm25Path = join(dir, "bm25.json");
  writeFileSync(bm25Path, SENTINEL_BYTES);
  return { root, dir, bm25Path, digest: sha256Of(bm25Path) };
}

/**
 * The env every b1 live-root case shares. HOME selects the guard's reference
 * (homedir()/memory-system); MEMORY_ROOT is pinned to that same fake live root
 * because lib/config.js's default root is the checkout that contains mcp/, no
 * longer homedir()/memory-system.
 */
function liveRootEnv(fakeHome, overrides = {}) {
  return baseEnv({
    HOME: fakeHome,
    MEMORY_ROOT: join(fakeHome, "memory-system"),
    STORAGE_BASE_DIR: undefined,
    POLICY_BASE_DIR: undefined,
    ...overrides,
  });
}

/**
 * assertLiveTreeIntact — the refusal's whole point: the seeded bm25.json is
 * byte-identical, no generation was published beside it, and no `_lexical`
 * tree was created in the live root.
 */
function assertLiveTreeIntact(sentinel) {
  assert.equal(
    sha256Of(sentinel.bm25Path),
    sentinel.digest,
    "the live bm25.json is byte-identical to the seed",
  );
  assert.equal(
    existsSync(join(sentinel.dir, "bm25.gen-0.json")),
    false,
    "no generation was published over the live index",
  );
  assert.equal(
    existsSync(join(sentinel.root, "indices", LEXICAL_INDEX_KEY)),
    false,
    "no _lexical tree was created in the live root",
  );
  // r4 — the guard is PRE-WRITE, so a refusal may not leave anything behind at
  // all. The CLI used to mkdir <root>/indices and <root>/storage inside
  // applyOutputContainment, i.e. BEFORE the guard ran, so a refused
  // --memory-root=<symlink-to-live> still wrote a directory under the sacred
  // root. ensureOutputDirs now runs only after every guard has passed.
  assert.equal(
    existsSync(join(sentinel.root, "storage")),
    false,
    "the refusal created no storage/ beside the live indices tree",
  );
}

// ---------------------------------------------------------------------------
// 1. THE RED CASE. The already-shipped env opt-in
// MEMORY_BM25_REBUILD_TARGET_ACTIVE=1 is dead through the CLI: the script's
// local resolveModelVersion() substitutes CAPS.GEMINI_EMBEDDING_MODEL_DEFAULT
// whenever no --model-version is passed, and main() then hands that value
// EXPLICITLY to rebuildBm25IndexFromLedger, so the library never consults its
// own _defaultRebuildModelVersion() (which honours the flag).
// ---------------------------------------------------------------------------
await test("env opt-in MEMORY_BM25_REBUILD_TARGET_ACTIVE=1 is honoured through the CLI", () => {
  const proc = runCli(
    ["--dry-run"],
    baseEnv({ MEMORY_BM25_REBUILD_TARGET_ACTIVE: "1" }),
  );
  assert.equal(proc.status, 0, `CLI exit 0 (stderr: ${proc.stderr})`);
  const env = envelopeOf(proc);
  assert.equal(
    env.model_version,
    ACTIVE_MODEL,
    "the env opt-in must reach _defaultRebuildModelVersion() through the CLI",
  );
});

// ---------------------------------------------------------------------------
// 2. THE ARGUMENT-LESS DEFAULT, through the CLI.
//
// This block previously read "the argument-less default must NOT flip. The
// retarget is opt-in only." l11 DELIBERATELY FLIPPED IT: the daemon's
// argument-less maybeRunBm25Rebuild() was re-creating indices/<legacy>/ via
// publishGeneration's unconditional mkdir, so with both MEMORY_BM25_* opt-ins
// unset the library default — and therefore this CLI's step-3 delegation — now
// resolves CAPS.ACTIVE_EMBED_MODEL_VERSION. The registered sibling suite
// (mcp/test/bm25-rebuild.test.mjs) moved with it in the same node.
//
// --memory-root is supplied because the script's PRE-EXISTING live-tree write
// guard refuses an uncontained non-dry-run publish of the ACTIVE model (see
// case 5 below). That guard is unchanged by l11; the retarget merely brought
// the argument-less path under it. The wrote_index / rows_indexed /
// memory_root assertions are the originals.
// ---------------------------------------------------------------------------
await test("both opt-ins unset + no args resolves the ACTIVE model", () => {
  const outRoot = join(TMP_ROOT, "out-default-target");
  const proc = runCli([`--memory-root=${outRoot}`], baseEnv());
  assert.equal(proc.status, 0, `CLI exit 0 (stderr: ${proc.stderr})`);
  const env = envelopeOf(proc);
  assert.equal(env.model_version, ACTIVE_MODEL);
  assert.notEqual(env.model_version, "gemini-embedding-001");
  assert.equal(env.wrote_index, true);
  assert.equal(env.rows_indexed, FIXTURE_ROWS);
  assert.equal(
    env.memory_root,
    outRoot,
    "the envelope echoes the effective output root",
  );
});

// l11 — the legacy tree stays reachable, but only by asking for it by name.
// baseEnv() is an allowlist, so this flag is absent from every other spawn in
// this file; proving it survives the spawn boundary proves the escape hatch is
// real for an operator, not just for in-process callers.
await test("MEMORY_BM25_REBUILD_TARGET_LEGACY=1 still resolves the legacy model", () => {
  const proc = runCli(
    ["--dry-run"],
    baseEnv({ MEMORY_BM25_REBUILD_TARGET_LEGACY: "1" }),
  );
  assert.equal(proc.status, 0, `CLI exit 0 (stderr: ${proc.stderr})`);
  const env = envelopeOf(proc);
  assert.equal(env.model_version, LEGACY_MODEL);
  assert.equal(env.model_version, "gemini-embedding-001");
});

// l11 CONSEQUENCE, pinned so it is never mistaken for a regression: an
// argument-less, uncontained, non-dry-run invocation now targets the ACTIVE
// model and is therefore REFUSED by the pre-existing live-tree write guard,
// where it used to publish into the legacy tree. Nothing is written either way.
await test("argument-less + uncontained + non-dry-run is now refused by the live-tree guard", () => {
  const before = indexTreeListing(MEMORY_ROOT);
  const proc = runCli([], baseEnv());
  assert.notEqual(proc.status, 0, "the guard must exit non-zero");
  assert.match(proc.stderr, /refusing to publish/);
  assert.match(proc.stderr, new RegExp(ACTIVE_MODEL));
  assert.equal((proc.stdout || "").trim(), "", "no envelope when refusing");
  assert.deepEqual(indexTreeListing(MEMORY_ROOT), before, "nothing written");
});

// ---------------------------------------------------------------------------
// 3. --target precedence.
// ---------------------------------------------------------------------------
await test("--target=active overrides the unset env flag", () => {
  const proc = runCli(["--target=active", "--dry-run"], baseEnv());
  assert.equal(proc.status, 0, `CLI exit 0 (stderr: ${proc.stderr})`);
  assert.equal(envelopeOf(proc).model_version, ACTIVE_MODEL);
});

await test("--target=legacy resolves gemini even with the ACTIVE env flag set", () => {
  const proc = runCli(
    ["--target=legacy", "--dry-run"],
    baseEnv({ MEMORY_BM25_REBUILD_TARGET_ACTIVE: "1" }),
  );
  assert.equal(proc.status, 0, `CLI exit 0 (stderr: ${proc.stderr})`);
  assert.equal(envelopeOf(proc).model_version, LEGACY_MODEL);
});

await test("explicit --model-version= beats --target=", () => {
  const proc = runCli(
    ["--target=active", "--model-version=l1-explicit-model", "--dry-run"],
    baseEnv({ MEMORY_BM25_REBUILD_TARGET_ACTIVE: "1" }),
  );
  assert.equal(proc.status, 0, `CLI exit 0 (stderr: ${proc.stderr})`);
  assert.equal(envelopeOf(proc).model_version, "l1-explicit-model");
});

await test("--contextual suffix semantics survive --target", () => {
  const proc = runCli(["--target=active", "--contextual", "--dry-run"], baseEnv());
  assert.equal(proc.status, 0, `CLI exit 0 (stderr: ${proc.stderr})`);
  const env = envelopeOf(proc);
  assert.equal(env.model_version, `${ACTIVE_MODEL}-contextual`);
  assert.equal(env.contextual_prefix, true);
});

await test("a bogus --target= exits non-zero, explains itself, and writes nothing", () => {
  const before = indexTreeListing(MEMORY_ROOT);
  const proc = runCli(["--target=bogus"], baseEnv());
  assert.notEqual(proc.status, 0, "bogus --target must not exit 0");
  assert.match(proc.stderr, /--target must be/);
  assert.equal((proc.stdout || "").trim(), "", "no envelope on a bad invocation");
  assert.deepEqual(indexTreeListing(MEMORY_ROOT), before, "nothing written");
});

// ---------------------------------------------------------------------------
// 4. --memory-root containment. Every byte lands under the supplied root, and
// LEDGERS_BASE_DIR stays pinned at the SUPPLIED ledger (not <root>/ledgers) —
// proven by rows_indexed matching the fixture's eligible row count. Without
// the re-pin the build would index zero rows and still report success.
// ---------------------------------------------------------------------------
await test("--memory-root contains every write and keeps the ledger read-only", () => {
  const outRoot = join(TMP_ROOT, "out-contained");
  const homeIndicesBefore = indexTreeListing(MEMORY_ROOT);

  const proc = runCli(
    ["--target=active", `--memory-root=${outRoot}`],
    baseEnv(),
  );
  assert.equal(proc.status, 0, `CLI exit 0 (stderr: ${proc.stderr})`);
  const env = envelopeOf(proc);

  assert.equal(env.model_version, ACTIVE_MODEL);
  assert.equal(env.memory_root, outRoot, "envelope echoes the contained root");
  assert.equal(env.wrote_index, true);
  assert.equal(
    env.rows_indexed,
    FIXTURE_ROWS,
    "LEDGERS_BASE_DIR still points at the supplied ledger, not <root>/ledgers",
  );
  assert.equal(env.ledger_path, DEFAULT_LEDGER);

  const expected = join(outRoot, "indices", ACTIVE_MODEL, "bm25.json");
  assert.equal(env.bm25_path, expected);
  assert.ok(existsSync(expected), "bm25.json under the contained root");

  assert.deepEqual(
    indexTreeListing(MEMORY_ROOT),
    homeIndicesBefore,
    "no file appeared under any indices/ path outside --memory-root",
  );
  assert.equal(
    existsSync(join(outRoot, "ledgers")),
    false,
    "the contained root grew no ledgers/ dir — production data was read in place",
  );
});

// ---------------------------------------------------------------------------
// 5. The live-tree write guard, with no --memory-root on the command line.
//
// CONTAINMENT: the child ALWAYS runs against an explicit temp MEMORY_ROOT —
// `<fakeHome>/memory-system` under TMP_ROOT, which the guard classifies as live
// through its home reference because HOME is pinned to that same fake home
// (liveRootEnv). It is never spawned with MEMORY_ROOT unset: lib/config.js's
// default root is the checkout that contains mcp/, so an unset MEMORY_ROOT
// would aim this non-dry-run `--target=active` rebuild at the REAL checkout
// with only the guard under test in between, and "nothing appeared under the
// fake home" would then be true whether or not the guard held.
//
// The evidence is a seeded sentinel bm25.json in the served ACTIVE tree of
// that temp live root: its digest and the whole index-tree listing must be
// unchanged after the refusal. LEDGERS_BASE_DIR is left pointing at the
// fixture ledger on purpose — a broken guard would build a real index from it
// and publish over the sentinel, which is exactly what the assertions catch.
// ---------------------------------------------------------------------------
await test("active target with no --memory-root and no --dry-run refuses to publish", () => {
  const fakeHome = join(TMP_ROOT, "guard-home");
  const sentinel = seedSentinel(fakeHome);
  const treeBefore = indexTreeListing(sentinel.root);
  const env = liveRootEnv(fakeHome);
  assert.equal(env.MEMORY_ROOT, sentinel.root, "the child's root is the temp live root");
  assert.ok(env.MEMORY_ROOT.startsWith(TMP_ROOT), "…and it lives under this file's TMP_ROOT");

  const proc = runCli(["--target=active"], env);

  assert.notEqual(proc.status, 0, "the guard must exit non-zero");
  assert.match(proc.stderr, /refusing to publish/);
  assert.match(proc.stderr, new RegExp(ACTIVE_MODEL));
  assert.equal((proc.stdout || "").trim(), "", "no envelope when refusing");
  assertLiveTreeIntact(sentinel);
  assert.deepEqual(
    indexTreeListing(sentinel.root),
    treeBefore,
    "the refusal left the live index tree's file listing unchanged",
  );
});

await test("the same run is allowed under --dry-run (guard is about WRITES)", () => {
  const fakeHome = join(TMP_ROOT, "guard-home-dry");
  const sentinel = seedSentinel(fakeHome);
  const treeBefore = indexTreeListing(sentinel.root);
  const env = liveRootEnv(fakeHome);
  assert.equal(env.MEMORY_ROOT, sentinel.root, "the child's root is the temp live root");

  const proc = runCli(["--target=active", "--dry-run"], env);

  assert.equal(proc.status, 0, `dry-run exit 0 (stderr: ${proc.stderr})`);
  assert.equal(envelopeOf(proc).wrote_index, false);
  assert.equal(
    sha256Of(sentinel.bm25Path),
    sentinel.digest,
    "a dry run leaves the live bm25.json byte-identical",
  );
  assert.deepEqual(
    indexTreeListing(sentinel.root),
    treeBefore,
    "a dry run adds nothing to the live index tree",
  );
});

// ---------------------------------------------------------------------------
// 5b (b1). THE GUARD MUST KEY ON THE PHYSICAL PUBLISH TARGET.
//
// The refusal above compared the LOGICAL model name against
// CAPS.ACTIVE_EMBED_MODEL_VERSION. But `_lexical` is not a tree — it is a
// PROJECTION, and rebuildBm25IndexFromLedger redirects it onto the ACTIVE
// model's tree (resolvePublishModelVersion) before publishing, then activates
// the neutral member from that generation. So naming `_lexical` — by the
// MEMORY_BM25_MODEL_NEUTRAL read-selector or by --model-version= — walked
// straight past a guard whose whole subject was the ACTIVE tree, and published
// over the index the running queryd serves.
//
// MEASURED PRE-FIX SIGNATURE of R1/R2 (recorded from an executed run, not
// asserted from the spec): exit 0, EMPTY stderr, an envelope on stdout, the
// seeded sentinel demoted to bm25.gen-0.json and a fresh bm25.json in its
// place — i.e. the sentinel's sha256 CHANGED. R3 returned wrote_index:true
// instead of throwing.
//
// Every root here lives under TMP_ROOT: HOME is a temp fake home and
// MEMORY_ROOT is pinned to that fake home's memory-system directory
// (liveRootEnv), so the guard's home reference is exercised hermetically and
// no child ever resolves the real checkout. LEDGERS_BASE_DIR still points at
// the fixture ledger on purpose: a broken guard builds a REAL index, which is
// exactly what the sentinel digest catches.
// ---------------------------------------------------------------------------
await test("b1 — MEMORY_BM25_MODEL_NEUTRAL=1 must not publish into the live ACTIVE tree", () => {
  const fakeHome = join(TMP_ROOT, "b1-home-neutral-flag");
  const sentinel = seedSentinel(fakeHome);
  const proc = runCli(
    [],
    liveRootEnv(fakeHome, { MEMORY_BM25_MODEL_NEUTRAL: "1" }),
  );

  assert.equal(proc.status, 2, `bad invocation exits 2 (stdout: ${proc.stdout})`);
  assert.match(proc.stderr, /refusing to publish/);
  assert.match(
    proc.stderr,
    new RegExp(LEXICAL_INDEX_KEY),
    "the refusal names the LOGICAL target the operator asked for",
  );
  assert.match(
    proc.stderr,
    new RegExp(ACTIVE_MODEL),
    "the refusal names the PHYSICAL tree that target publishes into",
  );
  assert.equal((proc.stdout || "").trim(), "", "no envelope when refusing");
  assertLiveTreeIntact(sentinel);
});

// The SAME refusal without the env flag. A fix that keyed on
// MEMORY_BM25_MODEL_NEUTRAL instead of on the resolved publish target would
// pass the case above and fail this one.
await test("b1 — --model-version=_lexical must not publish into the live ACTIVE tree", () => {
  const fakeHome = join(TMP_ROOT, "b1-home-neutral-arg");
  const sentinel = seedSentinel(fakeHome);
  const proc = runCli(
    [`--model-version=${LEXICAL_INDEX_KEY}`],
    liveRootEnv(fakeHome),
  );

  assert.equal(proc.status, 2, `bad invocation exits 2 (stdout: ${proc.stdout})`);
  assert.match(proc.stderr, /refusing to publish/);
  assert.match(proc.stderr, new RegExp(LEXICAL_INDEX_KEY));
  assert.match(proc.stderr, new RegExp(ACTIVE_MODEL));
  assert.equal((proc.stdout || "").trim(), "", "no envelope when refusing");
  assertLiveTreeIntact(sentinel);
});

// The LIBRARY seam. A CLI-only fix leaves every other caller — the daemon, a
// script, a REPL — able to publish over the served tree, so the refusal has to
// live where the publish decision is made. It THROWS rather than returning a
// `refused:` envelope: a soft refusal with wrote_index:false and exit 0 is the
// absence-reported-as-health shape this whole program exists to close.
await test("b1 — the LIBRARY refuses a live-tree _lexical publish, whoever asks", () => {
  const fakeHome = join(TMP_ROOT, "b1-home-library");
  const sentinel = seedSentinel(fakeHome);
  const before = treeListing(sentinel.root);

  const proc = runNodeModule(
    `const { rebuildBm25IndexFromLedger } = await import(${JSON.stringify(LIB_URL)});
     try {
       const result = rebuildBm25IndexFromLedger({
         ledgerPath: ${JSON.stringify(DEFAULT_LEDGER)},
         modelVersion: ${JSON.stringify(LEXICAL_INDEX_KEY)},
       });
       process.stdout.write(JSON.stringify({ threw: false, result }));
     } catch (err) {
       process.stdout.write(JSON.stringify({
         threw: true,
         code: err && err.code ? err.code : null,
         name: err && err.name ? err.name : null,
         message: err && err.message ? err.message : String(err),
       }));
     }`,
    liveRootEnv(fakeHome),
  );

  assert.equal(proc.status, 0, `the probe child ran (stderr: ${proc.stderr})`);
  const out = JSON.parse((proc.stdout || "").trim());
  assert.equal(
    out.threw,
    true,
    `the library must throw, got ${JSON.stringify(out.result)}`,
  );
  assert.equal(out.code, "bm25_live_tree_publish_not_armed");
  assert.match(out.message, new RegExp(LEXICAL_INDEX_KEY));
  assert.match(out.message, new RegExp(ACTIVE_MODEL));
  assert.deepEqual(
    treeListing(sentinel.root),
    before,
    "the live root gained zero files",
  );
  assert.equal(sha256Of(sentinel.bm25Path), sentinel.digest);
});

// ---------------------------------------------------------------------------
// 5c (b1). THE ARMED PATHS, held green BEFORE and AFTER. A guard that also
// stops the legitimate rebuilds is not a fix, it is a dead feature — and the
// daemon seam in particular must stay byte-identical in BOTH directions.
// ---------------------------------------------------------------------------

// (A) A contained active-target publish is still a publish. (Case 4 above pins
// containment itself; this pins that the physical-target guard does not fire
// on the very invocation the refusal text tells the operator to run.)
await test("b1 armed — --target=active --memory-root=<tmp> still publishes", () => {
  const outRoot = join(TMP_ROOT, "b1-armed-active");
  const proc = runCli(["--target=active", `--memory-root=${outRoot}`], baseEnv());
  assert.equal(proc.status, 0, `CLI exit 0 (stderr: ${proc.stderr})`);
  const env = envelopeOf(proc);
  assert.equal(env.wrote_index, true);
  assert.equal(env.bm25_path, join(outRoot, "indices", ACTIVE_MODEL, "bm25.json"));
  assert.ok(existsSync(env.bm25_path));
});

// (B) The neutral projection still builds — it just has to be contained. The
// redirect's DESTINATION is unchanged: it publishes THROUGH the ACTIVE tree
// under <root> and activates a `_lexical` member beside it.
await test("b1 armed — a contained MEMORY_BM25_MODEL_NEUTRAL=1 run still projects", () => {
  const outRoot = join(TMP_ROOT, "b1-armed-neutral");
  const proc = runCli(
    [`--memory-root=${outRoot}`],
    baseEnv({ MEMORY_BM25_MODEL_NEUTRAL: "1" }),
  );
  assert.equal(proc.status, 0, `CLI exit 0 (stderr: ${proc.stderr})`);
  const env = envelopeOf(proc);
  assert.equal(env.model_version, LEXICAL_INDEX_KEY);
  assert.equal(env.wrote_index, true);
  assert.ok(
    env.bm25_path.startsWith(join(outRoot, "indices", LEXICAL_INDEX_KEY) + "/"),
    `neutral member under the contained root, got ${env.bm25_path}`,
  );
  assert.ok(existsSync(env.bm25_path));
});

// (C) The one legitimate armed caller. `allowLiveTreePublish: true` is an
// in-process option ONLY — there is deliberately no environment variable that
// arms it, because an env flag routing around this guard is the defect itself.
await test("b1 armed — allowLiveTreePublish:true publishes into the live tree", () => {
  const fakeHome = join(TMP_ROOT, "b1-armed-library");
  const sentinel = seedSentinel(fakeHome);

  const proc = runNodeModule(
    `const { rebuildBm25IndexFromLedger } = await import(${JSON.stringify(LIB_URL)});
     process.stdout.write(JSON.stringify(rebuildBm25IndexFromLedger({
       ledgerPath: ${JSON.stringify(DEFAULT_LEDGER)},
       modelVersion: ${JSON.stringify(ACTIVE_MODEL)},
       allowLiveTreePublish: true,
     })));`,
    liveRootEnv(fakeHome),
  );

  assert.equal(proc.status, 0, `armed publish succeeds (stderr: ${proc.stderr})`);
  const env = JSON.parse((proc.stdout || "").trim());
  assert.equal(env.wrote_index, true);
  assert.equal(env.rows_indexed, FIXTURE_ROWS);
  assert.equal(env.bm25_path, sentinel.bm25Path);
  assert.notEqual(
    sha256Of(sentinel.bm25Path),
    sentinel.digest,
    "the armed caller DID publish — this is the control for the refusals above",
  );
});

// (D) The daemon seam, byte-identical in both directions. Its own
// `explicitlyArmed` gate — not a new flag — decides; the guard must be
// invisible to it.
await test("b1 armed — maybeRunBm25Rebuild keeps both of its daemon-seam verdicts", () => {
  const probe = (fakeHome, overrides) =>
    runNodeModule(
      `const { maybeRunBm25Rebuild } = await import(${JSON.stringify(LIB_URL)});
       process.stdout.write(JSON.stringify(maybeRunBm25Rebuild({
         ledgerPath: ${JSON.stringify(DEFAULT_LEDGER)},
         threshold: 1,
       })));`,
      liveRootEnv(fakeHome, overrides),
    );

  const unarmedHome = join(TMP_ROOT, "b1-daemon-unarmed");
  const unarmedSentinel = seedSentinel(unarmedHome);
  const unarmedBefore = treeListing(unarmedSentinel.root);
  const unarmed = probe(unarmedHome, {});
  assert.equal(unarmed.status, 0, `unarmed probe ran (stderr: ${unarmed.stderr})`);
  const unarmedOut = JSON.parse((unarmed.stdout || "").trim());
  assert.equal(unarmedOut.action, "disabled");
  assert.equal(unarmedOut.reason, "no_explicit_rebuild_target");
  assert.deepEqual(
    treeListing(unarmedSentinel.root),
    unarmedBefore,
    "the unarmed daemon tick still returns before any I/O",
  );

  const armedHome = join(TMP_ROOT, "b1-daemon-armed");
  const armedSentinel = seedSentinel(armedHome);
  const armed = probe(armedHome, { MEMORY_BM25_REBUILD_TARGET_ACTIVE: "1" });
  assert.equal(armed.status, 0, `armed probe ran (stderr: ${armed.stderr})`);
  const armedOut = JSON.parse((armed.stdout || "").trim());
  assert.equal(armedOut.action, "rebuilt", JSON.stringify(armedOut));
  assert.equal(armedOut.result.wrote_index, true);
  assert.notEqual(
    sha256Of(armedSentinel.bm25Path),
    armedSentinel.digest,
    "the armed daemon seam still publishes — the guard is invisible to it",
  );
});

// ---------------------------------------------------------------------------
// 5d (r4). THE TWO RESIDUALS b1 LEFT BEHIND.
//
// (b) b1's guard compared paths LEXICALLY — `resolve(MEMORY_ROOT) ===
//     resolve(homedir()/memory-system)` in the library, `memoryRoot ===
//     LIVE_ROOT` in the CLI. resolve() does not follow symlinks, so an aliased
//     root walked straight through both layers.
//
//     MEASURED PRE-FIX SIGNATURE (executed, not asserted from a spec):
//       (b-CLI)     --target=active --memory-root=<symlink-to-live>
//                   -> exit 0, EMPTY stderr, envelope on stdout, sentinel
//                      sha256 35f8339f... -> 2e97c193..., bm25.gen-0.json
//                      created.
//       (b-LIB)     MEMORY_ROOT=<symlink-to-live>, modelVersion=ACTIVE
//                   -> threw:false, wrote_index:true, same digest change.
//       (b-INDICES) a DISTINCT root whose `indices` child is a symlink into
//                   the live tree -> exit 0, same digest change. This is the
//                   case a root-only fix would still miss, which is why
//                   isLiveIndexRoot compares the `indices` directory that is
//                   actually written rather than the root.
//
// (a) The guard's subject was only the SERVED tree, so a NON-active target
//     under the live root was permitted:
//       (a-typo)    --model-version=<typo> -> exit 0, indices/<typo>/ created
//                   in the live root (treeListing grew by three files).
//       (a-lexctx)  MEMORY_BM25_MODEL_NEUTRAL=1 --contextual -> exit 0,
//                   indices/_lexical-contextual/ created in the live root.
//
//     NOTE on (a-lexctx)'s driver, measured rather than assumed: the suffix is
//     applied AFTER target resolution, so `_lexical` + "-contextual" is a
//     PLAIN tree and resolvePublishModelVersion does not redirect it — which
//     is exactly why b1's ACTIVE-only guard missed it.
//
// Every root here is under TMP_ROOT. FALSE-POSITIVE CONTROL: on this host
// TMP_ROOT itself sits under a symlinked ancestor (/var/folders/... ->
// /private/var/folders/...), so canonicalizing both sides could plausibly have
// started refusing ordinary temp roots. The contained-publish cases in 5c —
// and the explicit control at the end of this section — prove it does not.
// ---------------------------------------------------------------------------

/** A symlink at <TMP_ROOT>/<name> pointing at a seeded stand-in live root. */
function aliasTo(name, target) {
  const alias = join(TMP_ROOT, name);
  symlinkSync(target, alias);
  return alias;
}

await test("r4 — a --memory-root symlinked to the live root is refused (CLI)", () => {
  const fakeHome = join(TMP_ROOT, "r4-home-cli-alias");
  const sentinel = seedSentinel(fakeHome);
  const alias = aliasTo("r4-live-alias-cli", sentinel.root);

  const proc = runCli(
    ["--target=active", `--memory-root=${alias}`],
    liveRootEnv(fakeHome),
  );

  assert.equal(proc.status, 2, `symlinked root exits 2 (stdout: ${proc.stdout})`);
  assert.match(proc.stderr, /refusing to publish/);
  assert.match(proc.stderr, new RegExp(ACTIVE_MODEL));
  assert.equal((proc.stdout || "").trim(), "", "no envelope when refusing");
  assertLiveTreeIntact(sentinel);
});

await test("r4 — a MEMORY_ROOT symlinked to the live root is refused (LIBRARY)", () => {
  const fakeHome = join(TMP_ROOT, "r4-home-lib-alias");
  const sentinel = seedSentinel(fakeHome);
  const alias = aliasTo("r4-live-alias-lib", sentinel.root);
  const before = treeListing(sentinel.root);

  const proc = runNodeModule(
    `const { rebuildBm25IndexFromLedger } = await import(${JSON.stringify(LIB_URL)});
     try {
       const result = rebuildBm25IndexFromLedger({
         ledgerPath: ${JSON.stringify(DEFAULT_LEDGER)},
         modelVersion: ${JSON.stringify(ACTIVE_MODEL)},
       });
       process.stdout.write(JSON.stringify({ threw: false, result }));
     } catch (err) {
       process.stdout.write(JSON.stringify({
         threw: true,
         code: err && err.code ? err.code : null,
         message: err && err.message ? err.message : String(err),
       }));
     }`,
    liveRootEnv(fakeHome, {
      MEMORY_ROOT: alias,
      STORAGE_BASE_DIR: join(alias, "storage"),
    }),
  );

  assert.equal(proc.status, 0, `the probe child ran (stderr: ${proc.stderr})`);
  const out = JSON.parse((proc.stdout || "").trim());
  assert.equal(
    out.threw,
    true,
    `the library must throw, got ${JSON.stringify(out.result)}`,
  );
  assert.equal(out.code, "bm25_live_tree_publish_not_armed");
  assert.match(out.message, new RegExp(ACTIVE_MODEL));
  assert.deepEqual(treeListing(sentinel.root), before, "the live root gained zero files");
  assertLiveTreeIntact(sentinel);
});

// The case a ROOT-level fix would still miss: the root is genuinely distinct,
// only the directory that gets WRITTEN is shared.
await test("r4 — a root whose indices/ child symlinks into the live tree is refused", () => {
  const fakeHome = join(TMP_ROOT, "r4-home-indices-alias");
  const sentinel = seedSentinel(fakeHome);
  const aliasRoot = join(TMP_ROOT, "r4-indices-alias-root");
  mkdirSync(aliasRoot, { recursive: true, mode: 0o700 });
  symlinkSync(join(sentinel.root, "indices"), join(aliasRoot, "indices"));

  const proc = runCli(
    ["--target=active", `--memory-root=${aliasRoot}`],
    liveRootEnv(fakeHome),
  );

  assert.equal(proc.status, 2, `aliased indices/ exits 2 (stdout: ${proc.stdout})`);
  assert.match(proc.stderr, /refusing to publish/);
  assert.equal((proc.stdout || "").trim(), "", "no envelope when refusing");
  assertLiveTreeIntact(sentinel);
  assert.equal(
    existsSync(join(aliasRoot, "storage")),
    false,
    "the refused run created nothing beside the aliased indices/ either",
  );
});

// (a) A SIBLING tree in the live root. Not the served index, but still a
// directory the live system reads — and this is what a fat-fingered
// --model-version produced, silently, at exit 0.
const TYPO_MODEL = `${ACTIVE_MODEL}-typo`;

await test("r4 — a mistyped --model-version is refused under the live root", () => {
  const fakeHome = join(TMP_ROOT, "r4-home-typo");
  const sentinel = seedSentinel(fakeHome);
  const before = treeListing(sentinel.root);

  const proc = runCli([`--model-version=${TYPO_MODEL}`], liveRootEnv(fakeHome));

  assert.equal(proc.status, 2, `sibling publish exits 2 (stdout: ${proc.stdout})`);
  assert.match(proc.stderr, /refusing to publish/);
  assert.match(proc.stderr, new RegExp(TYPO_MODEL));
  assert.equal((proc.stdout || "").trim(), "", "no envelope when refusing");
  assert.deepEqual(
    treeListing(sentinel.root),
    before,
    "zero treeListing delta — pre-fix this run created indices/<typo>/",
  );
  assertLiveTreeIntact(sentinel);
});

await test("r4 — MEMORY_BM25_MODEL_NEUTRAL=1 --contextual is refused under the live root", () => {
  const fakeHome = join(TMP_ROOT, "r4-home-lexctx");
  const sentinel = seedSentinel(fakeHome);
  const before = treeListing(sentinel.root);

  const proc = runCli(
    ["--contextual"],
    liveRootEnv(fakeHome, { [BM25_MODEL_NEUTRAL_FLAG]: "1" }),
  );

  assert.equal(proc.status, 2, `sibling publish exits 2 (stdout: ${proc.stdout})`);
  assert.match(proc.stderr, /refusing to publish/);
  assert.match(proc.stderr, new RegExp(`${LEXICAL_INDEX_KEY}-contextual`));
  assert.deepEqual(treeListing(sentinel.root), before, "zero treeListing delta");
  assert.equal(
    existsSync(join(sentinel.root, "indices", `${LEXICAL_INDEX_KEY}-contextual`)),
    false,
    "no _lexical-contextual tree in the live root",
  );
  assertLiveTreeIntact(sentinel);
});

// THE DELIBERATE PATH. One explicit, human-typed acknowledgement naming the
// PHYSICAL tree. This is the invocation that keeps run-contextual-eval.mjs's
// hardcoded live ROOT (`indices/<model>-contextual/bm25.json`) one step away.
await test("r4 — --allow-live-tree=<exact physical target> publishes the sibling", () => {
  const fakeHome = join(TMP_ROOT, "r4-home-armed-sibling");
  const sentinel = seedSentinel(fakeHome);
  const target = `${LEXICAL_INDEX_KEY}-contextual`;

  const proc = runCli(
    ["--contextual", `--allow-live-tree=${target}`],
    liveRootEnv(fakeHome, { [BM25_MODEL_NEUTRAL_FLAG]: "1" }),
  );

  assert.equal(proc.status, 0, `armed sibling publishes (stderr: ${proc.stderr})`);
  const env = envelopeOf(proc);
  assert.equal(env.model_version, target);
  assert.equal(env.wrote_index, true);
  assert.equal(env.rows_indexed, FIXTURE_ROWS);
  assert.equal(env.bm25_path, join(sentinel.root, "indices", target, "bm25.json"));
  assert.ok(existsSync(env.bm25_path));
  // The SERVED tree is untouched even on the armed sibling path.
  assert.equal(
    sha256Of(sentinel.bm25Path),
    sentinel.digest,
    "arming a sibling never touches the served index",
  );
});

// The acknowledgement must name the tree that is actually written, exactly —
// that is the whole reason it is a value and not a bare boolean flag.
await test("r4 — --allow-live-tree with a mismatched value is refused, naming both", () => {
  const fakeHome = join(TMP_ROOT, "r4-home-armed-mismatch");
  const sentinel = seedSentinel(fakeHome);
  const before = treeListing(sentinel.root);

  const proc = runCli(
    [`--model-version=${TYPO_MODEL}`, `--allow-live-tree=${ACTIVE_MODEL}`],
    liveRootEnv(fakeHome),
  );

  assert.equal(proc.status, 2, `a mismatch exits 2 (stdout: ${proc.stdout})`);
  assert.match(proc.stderr, new RegExp(TYPO_MODEL), "names the physical target");
  assert.match(proc.stderr, new RegExp(ACTIVE_MODEL), "names the value supplied");
  assert.equal((proc.stdout || "").trim(), "", "no envelope when refusing");
  assert.deepEqual(treeListing(sentinel.root), before, "nothing built");
  assertLiveTreeIntact(sentinel);
});

// THE FLAG CAN NEVER REACH THE SERVED TREE. b1's refusal is checked first and
// does not consult --allow-live-tree at all.
await test("r4 — --allow-live-tree=<ACTIVE> does NOT reopen the served tree", () => {
  const fakeHome = join(TMP_ROOT, "r4-home-armed-active");
  const sentinel = seedSentinel(fakeHome);

  const proc = runCli(
    ["--target=active", `--allow-live-tree=${ACTIVE_MODEL}`],
    liveRootEnv(fakeHome),
  );

  assert.equal(proc.status, 2, `the served tree stays shut (stdout: ${proc.stdout})`);
  assert.match(proc.stderr, /refusing to publish/);
  assert.match(proc.stderr, new RegExp(ACTIVE_MODEL));
  assert.equal((proc.stdout || "").trim(), "", "no envelope when refusing");
  assertLiveTreeIntact(sentinel);
});

// NO ENV MAY ARM ANY LIVE-TREE WRITE — at either layer, for either half. An
// env flag routing around this write guard is the defect the whole guard
// exists to close, so the env-shaped spelling must simply do nothing.
await test("r4 — an env-shaped arming attempt has no effect at either layer", () => {
  const fakeHome = join(TMP_ROOT, "r4-home-env-arm");
  const sentinel = seedSentinel(fakeHome);
  const before = treeListing(sentinel.root);

  const cli = runCli(
    [`--model-version=${TYPO_MODEL}`],
    liveRootEnv(fakeHome, {
      MEMORY_BM25_ALLOW_LIVE_TREE: TYPO_MODEL,
      MEMORY_BM25_ALLOW_LIVE_TREE_SIBLING: "1",
    }),
  );
  assert.equal(cli.status, 2, `env arming is inert at the CLI (${cli.stdout})`);
  assert.match(cli.stderr, /refusing to publish/);

  const lib = runNodeModule(
    `const { rebuildBm25IndexFromLedger } = await import(${JSON.stringify(LIB_URL)});
     try {
       const result = rebuildBm25IndexFromLedger({
         ledgerPath: ${JSON.stringify(DEFAULT_LEDGER)},
         modelVersion: ${JSON.stringify(ACTIVE_MODEL)},
       });
       process.stdout.write(JSON.stringify({ threw: false, result }));
     } catch (err) {
       process.stdout.write(JSON.stringify({ threw: true, code: err && err.code }));
     }`,
    liveRootEnv(fakeHome, {
      MEMORY_BM25_ALLOW_LIVE_TREE: ACTIVE_MODEL,
      MEMORY_BM25_ALLOW_LIVE_TREE_SIBLING: "1",
    }),
  );
  assert.equal(lib.status, 0, `the probe child ran (stderr: ${lib.stderr})`);
  const out = JSON.parse((lib.stdout || "").trim());
  assert.equal(out.threw, true, "env arming is inert at the library too");
  assert.equal(out.code, "bm25_live_tree_publish_not_armed");

  assert.deepEqual(treeListing(sentinel.root), before, "nothing written either way");
  assertLiveTreeIntact(sentinel);
});

// FALSE-POSITIVE CONTROL, stated explicitly. A temp root is often reached
// through a symlinked ancestor (the default macOS temp dir is one:
// /var/folders/... -> /private/var/folders/...), so a predicate that walks
// aliases could plausibly have started refusing ordinary temp roots. It does
// not: a contained sibling publish still succeeds with no acknowledgement flag
// at all. The control BUILDS ITS OWN symlinked ancestor under TMP_ROOT rather
// than relying on the host temp dir being one, so it means the same thing under
// an already-canonical TMPDIR (/private/tmp/...). (r4-b1 replaced the
// realpath-string compare with a dev+ino identity compare; this case's
// protection now comes from the residual-tail half of that comparison — see
// the ancestor-sharing control in section 5e, which measures both sides of the
// same kind of invocation.)
await test("r4 — canonicalization does not start refusing legitimate temp roots", () => {
  const realParent = join(TMP_ROOT, "r4-real-parent");
  const linkParent = join(TMP_ROOT, "r4-link-parent");
  mkdirSync(realParent, { recursive: true });
  symlinkSync(realParent, linkParent);
  const outRoot = join(linkParent, "r4-false-positive-control");
  assert.notEqual(
    realpathSync(linkParent),
    linkParent,
    "this control is only meaningful if the out root really is under a symlink",
  );

  const proc = runCli(
    [`--model-version=${TYPO_MODEL}`, `--memory-root=${outRoot}`],
    baseEnv(),
  );

  assert.equal(proc.status, 0, `contained sibling publishes (stderr: ${proc.stderr})`);
  const env = envelopeOf(proc);
  assert.equal(env.wrote_index, true);
  assert.equal(env.bm25_path, join(outRoot, "indices", TYPO_MODEL, "bm25.json"));
  assert.ok(existsSync(env.bm25_path));
});

// ---------------------------------------------------------------------------
// 5e (r4-b1). THE ALIAS THE REALPATH COMPARE COULD NOT SEE.
//
// r4 compared realpathSync() STRINGS. realpath resolves symlinks and nothing
// else, so every aliasing mechanism that is not a symlink produced a spelling
// realpath handed straight back, and the guard read it as a different
// directory. MEASURED on this host, read-only, before the fix:
//
//   isLiveIndexRoot("<HOME>/memory-system")                    -> true
//   isLiveIndexRoot("<HOME>/MEMORY-SYSTEM")                    -> FALSE
//   isLiveIndexRoot("/System/Volumes/Data<HOME>/memory-system")-> FALSE
//
// all three being dev 16777230 / ino 180711302 — ONE directory. The hermetic
// reproduction of the first of those (CLI seam, stand-in live root under a
// scratch TMP) exited 0, rewrote the seeded bm25.json (sha256
// 35f8339f… -> be8f9cb0…) and left a bm25.gen-0.json behind; the library seam
// did the same and returned wrote_index:true instead of throwing.
//
// THE FIX compares DIRECTORY IDENTITY: dev+ino of the nearest existing
// ancestor (statSync follows symlinks) plus the not-yet-existing tail below it.
//
// PRE-FIX VERDICT OF EVERY SHAPE BELOW, each label backed by an executed run:
//   (a) case-alias of the live root, CLI + LIBRARY .............. RED
//   (b) case-alias on an INTERIOR segment (the home component) .. RED
//   (c) trailing slash ......................................... green-before
//   (d) ..-traversal via <live>/storage/.. ..................... green-before
//   (e) cwd-relative --memory-root ............................. green-before
// (c)/(d)/(e) were already refused because resolve() collapses `//`, `..` and
// a relative prefix LEXICALLY before realpath ever ran. They are carried here
// as COVERAGE — locking in behaviour the fix must not lose — not as red cases.
//
// HARDLINKED DIRECTORY: not constructible on this volume. linkSync() on a
// directory under TMPDIR fails with EPERM ("operation not permitted") on APFS,
// so there is deliberately NO assertion for that shape — a shape that cannot be
// built cannot honestly be reported as tested. The firmlink shape is not
// creatable at all; it is covered instead by the read-only in-process control
// at the end of this section, which asks the predicate about the REAL host's
// firmlink spelling without writing anything.
// ---------------------------------------------------------------------------

/**
 * caseFoldsHere — is the tmpdir family case-insensitive? The (a)/(b) cases are
 * only reproducible off the production root if it is, so this is asserted as a
 * PRECONDITION rather than assumed. Same dev+ino under two spellings, and
 * realpathSync returning each spelling verbatim, is exactly the state that
 * defeated the string compare.
 */
function caseFoldsHere() {
  const lower = join(TMP_ROOT, "case-fold-probe");
  const upper = join(TMP_ROOT, "CASE-FOLD-PROBE");
  if (!existsSync(lower)) mkdirSync(lower, { recursive: true, mode: 0o700 });
  let a;
  let b;
  try {
    a = statSync(lower, { bigint: true });
    b = statSync(upper, { bigint: true });
  } catch {
    return false;
  }
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    realpathSync(lower) !== realpathSync(upper)
  );
}

await test("r4-b1 — a case-aliased --memory-root is refused (CLI)", () => {
  assert.equal(caseFoldsHere(), true, "precondition: TMPDIR family case-folds");
  const fakeHome = join(TMP_ROOT, "r4b1-home-case-cli");
  const sentinel = seedSentinel(fakeHome);
  const before = treeListing(sentinel.root);
  const alias = join(fakeHome, "MEMORY-SYSTEM");
  assert.notEqual(alias, sentinel.root, "the alias is a different STRING");
  assert.equal(
    String(statSync(alias, { bigint: true }).ino),
    String(statSync(sentinel.root, { bigint: true }).ino),
    "…naming the same directory (this is what realpath could not see)",
  );

  const proc = runCli(
    ["--target=active", `--memory-root=${alias}`],
    liveRootEnv(fakeHome),
  );

  assert.equal(proc.status, 2, `case-alias exits 2 (stdout: ${proc.stdout})`);
  assert.match(proc.stderr, /refusing to publish/);
  assert.match(proc.stderr, new RegExp(ACTIVE_MODEL));
  assert.equal((proc.stdout || "").trim(), "", "no envelope when refusing");
  assert.deepEqual(treeListing(sentinel.root), before, "zero treeListing delta");
  assertLiveTreeIntact(sentinel);
});

await test("r4-b1 — a case-aliased MEMORY_ROOT is refused (LIBRARY)", () => {
  assert.equal(caseFoldsHere(), true, "precondition: TMPDIR family case-folds");
  const fakeHome = join(TMP_ROOT, "r4b1-home-case-lib");
  const sentinel = seedSentinel(fakeHome);
  const before = treeListing(sentinel.root);
  const alias = join(fakeHome, "MEMORY-SYSTEM");

  const proc = runNodeModule(
    `const { rebuildBm25IndexFromLedger } = await import(${JSON.stringify(LIB_URL)});
     try {
       const result = rebuildBm25IndexFromLedger({
         ledgerPath: ${JSON.stringify(DEFAULT_LEDGER)},
         modelVersion: ${JSON.stringify(ACTIVE_MODEL)},
       });
       process.stdout.write(JSON.stringify({ threw: false, result }));
     } catch (err) {
       process.stdout.write(JSON.stringify({
         threw: true,
         code: err && err.code ? err.code : null,
         message: err && err.message ? err.message : String(err),
       }));
     }`,
    liveRootEnv(fakeHome, {
      MEMORY_ROOT: alias,
      STORAGE_BASE_DIR: join(alias, "storage"),
    }),
  );

  assert.equal(proc.status, 0, `the probe child ran (stderr: ${proc.stderr})`);
  const out = JSON.parse((proc.stdout || "").trim());
  assert.equal(
    out.threw,
    true,
    `the library must throw, got ${JSON.stringify(out.result)}`,
  );
  assert.equal(out.code, "bm25_live_tree_publish_not_armed");
  assert.deepEqual(treeListing(sentinel.root), before, "zero treeListing delta");
  assertLiveTreeIntact(sentinel);
});

// (b) The alias is on an INTERIOR segment, not the leaf: the guard must not be
// looking at the last component alone.
await test("r4-b1 — a case-alias on an INTERIOR path segment is refused", () => {
  assert.equal(caseFoldsHere(), true, "precondition: TMPDIR family case-folds");
  const fakeHome = join(TMP_ROOT, "r4b1-interior-home");
  const sentinel = seedSentinel(fakeHome);
  const before = treeListing(sentinel.root);
  // Same leaf spelling; only the HOME component changes case.
  const alias = join(TMP_ROOT, "R4B1-INTERIOR-HOME", "memory-system");

  const proc = runCli(
    ["--target=active", `--memory-root=${alias}`],
    liveRootEnv(fakeHome),
  );

  assert.equal(proc.status, 2, `interior alias exits 2 (stdout: ${proc.stdout})`);
  assert.match(proc.stderr, /refusing to publish/);
  assert.equal((proc.stdout || "").trim(), "", "no envelope when refusing");
  assert.deepEqual(treeListing(sentinel.root), before, "zero treeListing delta");
  assertLiveTreeIntact(sentinel);
});

// (c) COVERAGE, green-before: resolve() strips the trailing slash lexically.
await test("r4-b1 — a trailing-slash --memory-root stays refused", () => {
  const fakeHome = join(TMP_ROOT, "r4b1-home-slash");
  const sentinel = seedSentinel(fakeHome);
  const before = treeListing(sentinel.root);

  const proc = runCli(
    ["--target=active", `--memory-root=${sentinel.root}/`],
    liveRootEnv(fakeHome),
  );

  assert.equal(proc.status, 2, `trailing slash exits 2 (stdout: ${proc.stdout})`);
  assert.match(proc.stderr, /refusing to publish/);
  assert.equal((proc.stdout || "").trim(), "", "no envelope when refusing");
  assert.deepEqual(treeListing(sentinel.root), before, "zero treeListing delta");
  assertLiveTreeIntact(sentinel);
});

// (d) COVERAGE, green-before: resolve() collapses `..` lexically. The traversal
// goes through a REAL directory (storage/ is created first) so the shape is the
// one an operator would actually type, not a path that only exists on paper.
await test("r4-b1 — a ..-traversal --memory-root stays refused", () => {
  const fakeHome = join(TMP_ROOT, "r4b1-home-dotdot");
  const sentinel = seedSentinel(fakeHome);
  mkdirSync(join(sentinel.root, "storage"), { recursive: true, mode: 0o700 });
  const before = treeListing(sentinel.root);

  const proc = runCli(
    ["--target=active", `--memory-root=${join(sentinel.root, "storage")}/..`],
    liveRootEnv(fakeHome),
  );

  assert.equal(proc.status, 2, `..-traversal exits 2 (stdout: ${proc.stdout})`);
  assert.match(proc.stderr, /refusing to publish/);
  assert.equal((proc.stdout || "").trim(), "", "no envelope when refusing");
  assert.deepEqual(treeListing(sentinel.root), before, "zero treeListing delta");
  assert.equal(
    sha256Of(sentinel.bm25Path),
    sentinel.digest,
    "the live bm25.json is byte-identical to the seed",
  );
  assert.equal(existsSync(join(sentinel.dir, "bm25.gen-0.json")), false);
});

// (e) COVERAGE, green-before. MEASURED SHAPE, not a presumed one:
// applyOutputContainment does `resolve(memoryRootArg)`, and process.cwd() on
// macOS already reports the PHYSICAL path, so a relative --memory-root is
// echoed back /private-prefixed — realpathSync(fakeHome), not fakeHome. The
// assertion below is on what that actually produces.
await test("r4-b1 — a cwd-relative --memory-root stays refused", () => {
  const fakeHome = join(TMP_ROOT, "r4b1-home-relative");
  const sentinel = seedSentinel(fakeHome);
  const before = treeListing(sentinel.root);

  const proc = runCli(
    ["--target=active", "--memory-root=memory-system"],
    liveRootEnv(fakeHome),
    fakeHome,
  );

  assert.equal(proc.status, 2, `relative root exits 2 (stdout: ${proc.stdout})`);
  assert.match(proc.stderr, /refusing to publish/);
  assert.ok(
    proc.stderr.includes(join(realpathSync(fakeHome), "memory-system")),
    `stderr names the PHYSICAL resolved root; got: ${proc.stderr}`,
  );
  assert.equal((proc.stdout || "").trim(), "", "no envelope when refusing");
  assert.deepEqual(treeListing(sentinel.root), before, "zero treeListing delta");
  assertLiveTreeIntact(sentinel);
});

// FALSE-POSITIVE CONTROL FOR THE dev+ino DESIGN SPECIFICALLY.
//
// baseEnv()'s HOME is <TMP_ROOT>/fake-home, which is never created, so the
// reference side walks all the way up to TMP_ROOT — the SAME nearest existing
// ancestor, hence the SAME dev+ino, as any temp output root directly under
// TMP_ROOT. An identity comparison that stopped at the ancestor would refuse
// every one of this file's contained publishes. The residual tails
// (["fake-home","memory-system","indices"] vs ["<out>","indices"]) are what
// keeps them apart, which is what makes this fix a tightening rather than a
// blanket refusal.
await test("r4-b1 — a temp root sharing an ancestor with the live root still publishes", () => {
  const outRoot = join(TMP_ROOT, "r4b1-ancestor-out");
  const fakeHome = join(TMP_ROOT, "fake-home");
  assert.equal(existsSync(fakeHome), false, "baseEnv()'s HOME does not exist");
  assert.equal(existsSync(outRoot), false, "nor does the output root, yet");
  assert.equal(
    dirname(fakeHome),
    dirname(outRoot),
    "both sides' nearest existing ancestor is the one TMP_ROOT",
  );

  const proc = runCli(["--target=active", `--memory-root=${outRoot}`], baseEnv());

  assert.equal(proc.status, 0, `ancestor-sharing root publishes (stderr: ${proc.stderr})`);
  const env = envelopeOf(proc);
  assert.equal(env.wrote_index, true);
  assert.equal(env.rows_indexed, FIXTURE_ROWS);
  assert.equal(env.bm25_path, join(outRoot, "indices", ACTIVE_MODEL, "bm25.json"));
  assert.ok(existsSync(env.bm25_path));
});

// THE FIRMLINK CONTROL. /System/Volumes/Data/<home> is an APFS firmlink: it
// cannot be created, only observed, so this is the only honest way to cover it.
// It performs NO writes of any kind: it stats the real host's three spellings
// and asks the predicate about them. Guarded by existsSync so a host without
// those spellings degrades to a skip instead of a false green.
const REAL_LIVE_ROOT = join(homedir(), "memory-system");
const REAL_CASE_ALIAS = join(homedir(), "MEMORY-SYSTEM");
const REAL_FIRMLINK = join(
  "/System/Volumes/Data",
  homedir().replace(/^\/+/, ""),
  "memory-system",
);

await test("r4-b1 — the REAL host's alias spellings all read as the live root", async (t) => {
  if (
    !existsSync(REAL_LIVE_ROOT) ||
    !existsSync(REAL_CASE_ALIAS) ||
    !existsSync(REAL_FIRMLINK)
  ) {
    t.skip("host has no case-alias / firmlink spelling of the live root");
    return;
  }
  // Importing the library in-process is safe: module evaluation was measured to
  // create nothing (imported under a MEMORY_ROOT pointing at a path that did
  // not exist; the path was still absent afterwards).
  const { isLiveIndexRoot } = await import("../lib/recall/bm25-rebuild.js");

  const identity = (p) => {
    const s = statSync(p, { bigint: true });
    return `${s.dev}:${s.ino}`;
  };
  const canonical = identity(REAL_LIVE_ROOT);
  assert.equal(identity(REAL_CASE_ALIAS), canonical, "case-alias is ONE dir");
  assert.equal(identity(REAL_FIRMLINK), canonical, "firmlink is ONE dir");

  // Pre-fix these two returned FALSE — realpath handed each spelling back
  // verbatim, so the string compare called them different directories.
  assert.equal(isLiveIndexRoot(REAL_LIVE_ROOT), true, "canonical spelling");
  assert.equal(isLiveIndexRoot(REAL_CASE_ALIAS), true, "case-alias spelling");
  assert.equal(isLiveIndexRoot(REAL_FIRMLINK), true, "firmlink spelling");
  // Green before AND after; carried so the lexical collapse cannot regress.
  assert.equal(isLiveIndexRoot(`${REAL_LIVE_ROOT}/`), true, "trailing slash");
  assert.equal(
    isLiveIndexRoot(`${REAL_LIVE_ROOT}/storage/..`),
    true,
    "..-traversal",
  );
});

// THE HARDLINKED-DIRECTORY SHAPE, recorded rather than claimed. This case
// asserts only that the shape CANNOT BE BUILT on this volume — it makes no
// claim about the guard, because a shape that cannot be constructed cannot
// honestly be reported as covered. If a future volume does permit it, this
// case fails and forces the guard to be exercised against it for real.
await test("r4-b1 — a hardlinked directory is not constructible on this volume", () => {
  const src = join(TMP_ROOT, "r4b1-hardlink-src");
  mkdirSync(src, { recursive: true, mode: 0o700 });
  let errno = null;
  try {
    linkSync(src, join(TMP_ROOT, "r4b1-hardlink-dst"));
  } catch (err) {
    errno = err && err.code;
  }
  assert.equal(
    errno,
    "EPERM",
    "APFS refuses link() on a directory; that shape ships untested by design",
  );
});

// ---------------------------------------------------------------------------
// 5f (r4-b1-guard-residuals). THE SAME ALIAS, ONE LEVEL DOWN: the MODEL VERSION.
//
// 5e fixed the ROOT compare. The served-tree question inside it was still a
// STRING compare on the model version — `publishModelVersion ===
// CAPS.ACTIVE_EMBED_MODEL_VERSION` in the library, `targetsActive` in the CLI.
// But a model version is a PATH COMPONENT: publishGeneration writes
// `MEMORY_ROOT/indices/<publishModelVersion>` (index-cache.js indicesDir() +
// indexPathsFor()). So every alias that defeated the root compare defeats the
// name compare too — and an aliased name is worse, because failing the string
// test routes it to the SIBLING arm, whose --allow-live-tree /
// allowLiveTreeSiblingPublish acknowledgement then publishes it straight over
// the served index.
//
// PRE-FIX VERDICT OF EVERY SHAPE BELOW — all four RED, each backed by an
// executed run at BOTH seams (stand-in live root under TMP; CLI
// `--model-version=<x> --allow-live-tree=<x>`; library
// `allowLiveTreeSiblingPublish:true`). Every one: exit 0, EMPTY stderr, seeded
// bm25.json sha256 35f8339f… -> 54e3c1bb…, bm25.gen-0.json created:
//   (a) case variant `QWEN3-EMBEDDING-8B-FP16` .................. RED
//   (b) `<active>-alias`, a symlink to the served directory ..... RED
//   (c) `<active>/../<active>` traversal ........................ RED
//   (d) `<active>/` trailing slash .............................. RED
// (c) and (d) are RED here even though the same spellings were green-before as
// --memory-root values in 5e: resolve() collapsed them on the ROOT path, but
// nothing collapsed them before a `===` against the model-version string.
//
// THE DISCRIMINATOR AGAINST A BLANKET REFUSE: the four positive controls that
// already run BEFORE this section — "b1 armed — --target=active
// --memory-root=<tmp> still publishes", "b1 armed — allowLiveTreePublish:true
// publishes into the live tree", "b1 armed — maybeRunBm25Rebuild keeps both of
// its daemon-seam verdicts", and "r4 — --allow-live-tree=<exact physical
// target> publishes the sibling". An implementation that simply refused
// everything would pass every case below and fail all four of those. They are
// upstream in this file on purpose, so the file reads as: prove the armed paths
// still work, THEN prove the aliases cannot.
//
// FIRMLINK: still not constructible in TMPDIR (it is an APFS volume feature,
// not a file operation), so it is covered by the read-only in-process control
// at the end of this section, which writes nothing.
// ---------------------------------------------------------------------------

/**
 * seedAliasCase — one stand-in live root plus the aliased model-version
 * spelling under test. Reuses seedSentinel; `mk` may create a symlink inside
 * the seeded indices/ tree and returns the model-version string to publish.
 */
function seedAliasCase(name, mk) {
  const fakeHome = join(TMP_ROOT, name);
  const sentinel = seedSentinel(fakeHome);
  const model = mk(sentinel);
  return { fakeHome, sentinel, model, before: treeListing(sentinel.root) };
}

/** The armed CLI invocation the pre-fix runs used: the alias, typed twice. */
function runAliasCli(c) {
  return runCli(
    [`--model-version=${c.model}`, `--allow-live-tree=${c.model}`],
    liveRootEnv(c.fakeHome),
  );
}

/** The armed LIBRARY invocation the pre-fix runs used. */
function runAliasLib(c) {
  return runNodeModule(
    `const { rebuildBm25IndexFromLedger } = await import(${JSON.stringify(LIB_URL)});
     try {
       const result = rebuildBm25IndexFromLedger({
         ledgerPath: ${JSON.stringify(DEFAULT_LEDGER)},
         modelVersion: ${JSON.stringify(c.model)},
         allowLiveTreeSiblingPublish: true,
       });
       process.stdout.write(JSON.stringify({ threw: false, result }));
     } catch (err) {
       process.stdout.write(JSON.stringify({
         threw: true,
         code: err && err.code ? err.code : null,
         message: err && err.message ? err.message : String(err),
       }));
     }`,
    liveRootEnv(c.fakeHome, {
      MEMORY_ROOT: c.sentinel.root,
      STORAGE_BASE_DIR: join(c.sentinel.root, "storage"),
    }),
  );
}

/** CLI refusal shape: exit 2, no envelope, nothing created, sentinel intact. */
function assertCliRefused(c, proc) {
  assert.equal(proc.status, 2, `exits 2 (stdout: ${proc.stdout})`);
  assert.match(proc.stderr, /refusing to publish/);
  assert.equal((proc.stdout || "").trim(), "", "no envelope when refusing");
  assert.deepEqual(treeListing(c.sentinel.root), c.before, "zero treeListing delta");
  assertLiveTreeIntact(c.sentinel);
}

/** LIBRARY refusal shape: the SERVED-tree code, not the sibling one. */
function assertLibRefused(c, proc) {
  assert.equal(proc.status, 0, `the probe child ran (stderr: ${proc.stderr})`);
  const out = JSON.parse((proc.stdout || "").trim());
  assert.equal(
    out.threw,
    true,
    `the library must throw, got ${JSON.stringify(out.result)}`,
  );
  // The SERVED code, not bm25_live_tree_sibling_publish_not_armed: the whole
  // defect was this destination being classified as a sibling, where the opt
  // that IS set would have unlocked it.
  assert.equal(out.code, "bm25_live_tree_publish_not_armed");
  assert.deepEqual(treeListing(c.sentinel.root), c.before, "zero treeListing delta");
  assertLiveTreeIntact(c.sentinel);
}

// (a) case variant of the ACTIVE model version.
await test("r4-b1 — a case-variant MODEL VERSION cannot alias into the served tree (CLI)", () => {
  assert.equal(caseFoldsHere(), true, "precondition: TMPDIR family case-folds");
  const c = seedAliasCase("r4b1r-model-case-cli", () => ACTIVE_MODEL.toUpperCase());
  assert.notEqual(c.model, ACTIVE_MODEL, "the spelling differs from the ACTIVE name");
  assertCliRefused(c, runAliasCli(c));
});

await test("r4-b1 — a case-variant MODEL VERSION cannot alias into the served tree (LIBRARY)", () => {
  assert.equal(caseFoldsHere(), true, "precondition: TMPDIR family case-folds");
  const c = seedAliasCase("r4b1r-model-case-lib", () => ACTIVE_MODEL.toUpperCase());
  assertLibRefused(c, runAliasLib(c));
});

// (b) a model-version directory that is a SYMLINK to the served one. The name
// is not even close to the ACTIVE spelling — only the destination gives it away.
await test("r4-b1 — a symlinked model-version directory cannot alias into the served tree (CLI)", () => {
  const c = seedAliasCase("r4b1r-model-symlink-cli", (s) => {
    const alias = `${ACTIVE_MODEL}-alias`;
    symlinkSync(s.dir, join(s.root, "indices", alias));
    return alias;
  });
  assert.equal(
    String(statSync(join(c.sentinel.root, "indices", c.model), { bigint: true }).ino),
    String(statSync(c.sentinel.dir, { bigint: true }).ino),
    "precondition: the alias directory IS the served directory",
  );
  assertCliRefused(c, runAliasCli(c));
});

await test("r4-b1 — a symlinked model-version directory cannot alias into the served tree (LIBRARY)", () => {
  const c = seedAliasCase("r4b1r-model-symlink-lib", (s) => {
    const alias = `${ACTIVE_MODEL}-alias`;
    symlinkSync(s.dir, join(s.root, "indices", alias));
    return alias;
  });
  assertLibRefused(c, runAliasLib(c));
});

// (c) traversal that collapses onto the served directory. RED before the fix:
// join() normalizes it for the WRITE, but `===` never saw the normalized form.
await test("r4-b1 — a ..-traversal MODEL VERSION cannot alias into the served tree (CLI)", () => {
  const c = seedAliasCase(
    "r4b1r-model-dotdot-cli",
    () => `${ACTIVE_MODEL}/../${ACTIVE_MODEL}`,
  );
  assertCliRefused(c, runAliasCli(c));
});

await test("r4-b1 — a ..-traversal MODEL VERSION cannot alias into the served tree (LIBRARY)", () => {
  const c = seedAliasCase(
    "r4b1r-model-dotdot-lib",
    () => `${ACTIVE_MODEL}/../${ACTIVE_MODEL}`,
  );
  assertLibRefused(c, runAliasLib(c));
});

// (d) trailing slash. Also RED before the fix, for the same reason as (c).
await test("r4-b1 — a trailing-slash MODEL VERSION cannot alias into the served tree (CLI)", () => {
  const c = seedAliasCase("r4b1r-model-slash-cli", () => `${ACTIVE_MODEL}/`);
  assertCliRefused(c, runAliasCli(c));
});

await test("r4-b1 — a trailing-slash MODEL VERSION cannot alias into the served tree (LIBRARY)", () => {
  const c = seedAliasCase("r4b1r-model-slash-lib", () => `${ACTIVE_MODEL}/`);
  assertLibRefused(c, runAliasLib(c));
});

// THE FIRMLINK CONTROL FOR THE DESTINATION PREDICATE. Read-only, in-process,
// writes nothing — same existence precondition as the isLiveIndexRoot control
// above, because /System/Volumes/Data/<home> is an APFS firmlink that can be
// observed but never constructed under TMPDIR.
//
// The second assertion is the anti-vacuity half: a predicate hard-wired to true
// would pass the first and fail this one.
await test("r4-b1 — isServedIndexTree reads the REAL host's firmlink spelling as the served tree", async (t) => {
  if (!existsSync(REAL_LIVE_ROOT) || !existsSync(REAL_FIRMLINK)) {
    t.skip("host has no firmlink spelling of the live root");
    return;
  }
  const { isServedIndexTree } = await import("../lib/recall/bm25-rebuild.js");

  assert.equal(
    isServedIndexTree(REAL_FIRMLINK, ACTIVE_MODEL),
    true,
    "the firmlink spelling names the served index directory",
  );
  // A model version that does not exist under the REAL live root: its
  // destination ENOENTs and carries a non-empty residual, which is the
  // filesystem's own answer that it is not the served directory. This is the
  // measured bound on the string-compared residual tail.
  const absent = "r4b1-model-version-that-does-not-exist";
  assert.equal(
    existsSync(join(REAL_LIVE_ROOT, "indices", absent)),
    false,
    "precondition: that model version really is absent",
  );
  assert.equal(
    isServedIndexTree(REAL_LIVE_ROOT, absent),
    false,
    "an absent destination is NOT the served tree — the predicate discriminates",
  );
});

// ---------------------------------------------------------------------------
// 5g (r5). THE COMPOSITION, not the predicate: a correct identity answer that
// could not decide anything.
//
// 5e fixed the ROOT compare; 5f fixed the MODEL-VERSION compare. Both landed
// their measurement inside a composition that subordinated it to an
// ARGUMENT-PRESENCE proxy. At the CLI the served refusal read
//   targetsServed && !dryRun && (opts.memoryRoot === undefined || liveTree)
// and at the library the whole disjunction lived inside
//   if (!dryRun && !allowLiveTreePublish && isLiveIndexRoot(MEMORY_ROOT)) { … }
// so on every run that passes `--memory-root` at a root that is NOT the live
// root, the destination measurement was a strict no-op — correct, and inert
// exactly where it was added to help.
//
// THE SHAPE THAT EXPOSES IT: a sibling, genuinely non-live root `<other>`
// whose `indices/<model>` child is a symlink at the SERVED directory. The
// precondition pair IS the statement of the defect and is asserted on every
// case below, so none of them can pass vacuously:
//     isServedIndexTree(<other>, <model>) === true
//     isLiveIndexRoot(<other>)            === false
//
// PRE-FIX VERDICT OF EVERY RED CASE BELOW, each backed by an executed run
// against a stand-in live root under TMP (never the real indices/):
//   R1 CLI  `--target=active --memory-root=<other>` (name=true) ......... RED
//           exit 0, empty stderr, sentinel 35f8339f… -> df23aa87…,
//           bm25.gen-0.json created, `<other>/storage` created.
//   R2 LIB  MEMORY_ROOT=<other>, modelVersion=<ACTIVE> ................. RED
//           threw=false, wrote_index:true, same clobber.
//   R3 CLI  `--model-version=<ACTIVE>-alias --memory-root=<other>`, no
//           --allow-live-tree (name=FALSE) ............................. RED
//           exit 0, same clobber — so a refusal here can only be coming from
//           the identity term.
// POST-FIX all three are exit 2 / a throw with code
// bm25_live_tree_publish_not_armed, sentinel byte-identical, no gen-0 file,
// and no `storage/` under either root.
//
// WHAT r5 DOES NOT CLOSE, measured rather than asserted: see the residual case
// at the end of this section — a non-live root whose SIBLING (non-served)
// model-version child symlinks under the live root. PERMIT before and PERMIT
// after, so not a monotonicity violation; closing it needs a THIRD containment
// rule ("is the destination anywhere under the live root"), which this node
// deliberately does not add.
// ---------------------------------------------------------------------------

/**
 * seedAliasedRootCase — the 5g fixture: a stand-in live root with the sentinel
 * (seedSentinel) PLUS a sibling, genuinely non-live `<other>` root. `mk` is
 * handed both and creates the aliasing child inside `<other>/indices`,
 * returning the model-version string to publish.
 */
function seedAliasedRootCase(name, mk) {
  const fakeHome = join(TMP_ROOT, name);
  const sentinel = seedSentinel(fakeHome);
  const other = join(TMP_ROOT, `${name}-other`);
  mkdirSync(join(other, "indices"), { recursive: true, mode: 0o700 });
  const model = mk(sentinel, other);
  return {
    fakeHome,
    sentinel,
    other,
    model,
    before: treeListing(sentinel.root),
    otherBefore: treeListing(other),
  };
}

/** `<other>/indices/<model>` -> the seeded served directory. */
function aliasServedAt(model) {
  return (s, other) => {
    symlinkSync(s.dir, join(other, "indices", model));
    return model;
  };
}

/**
 * measureGuardPair — ask the LIBRARY's own two predicates about a (root, model)
 * pair, in a CHILD under the case's HOME. They derive their reference side from
 * homedir() and this file's own process HOME is the real one, so a child is the
 * only honest way to ask. IMPORTED, never re-derived: nothing in this section
 * compares dev/ino or spells a containment rule of its own — two copies of that
 * rule is how the b1 bypass came to exist in the first place.
 */
function measureGuardPair(fakeHome, root, model) {
  const proc = runNodeModule(
    `const m = await import(${JSON.stringify(LIB_URL)});
     process.stdout.write(JSON.stringify({
       served: m.isServedIndexTree(process.env.R5_ROOT, process.env.R5_MODEL),
       live: m.isLiveIndexRoot(process.env.R5_ROOT),
     }));`,
    liveRootEnv(fakeHome, { R5_ROOT: root, R5_MODEL: model }),
  );
  assert.equal(proc.status, 0, `the predicate probe ran (stderr: ${proc.stderr})`);
  return JSON.parse((proc.stdout || "").trim());
}

/**
 * assertAliasedPreconditions — THE STATEMENT OF THE DEFECT, executed. A case
 * whose pair is not (served=true, live=false) is not testing r5 at all.
 */
function assertAliasedPreconditions(c, model = c.model) {
  const pair = measureGuardPair(c.fakeHome, c.other, model);
  assert.equal(
    pair.served,
    true,
    `precondition: <other>/indices/${model} IS the served directory`,
  );
  assert.equal(
    pair.live,
    false,
    "precondition: <other> is NOT the live root — the proxy the old " +
      "composition consulted says 'contained', which is why it was inert",
  );
}

/** The `<other>` root must be left as untouched as the live one by a refusal. */
function assertOtherRootPristine(c) {
  assert.deepEqual(
    treeListing(c.other),
    c.otherBefore,
    "zero treeListing delta under the passed --memory-root",
  );
  assert.equal(
    existsSync(join(c.other, "storage")),
    false,
    "ensureOutputDirs still runs strictly after every guard: no storage/ " +
      "under the root the refusal was handed",
  );
}

/** The 5g CLI invocation: contained root, no acknowledgement flag anywhere. */
function runAliasedCli(c, args) {
  return runCli([...args, `--memory-root=${c.other}`], liveRootEnv(c.fakeHome));
}

/** The 5g LIBRARY invocation: MEMORY_ROOT is the contained, non-live root. */
function runAliasedLib(c, extraOpts = "") {
  return runNodeModule(
    `const { rebuildBm25IndexFromLedger } = await import(${JSON.stringify(LIB_URL)});
     try {
       const result = rebuildBm25IndexFromLedger({
         ledgerPath: ${JSON.stringify(DEFAULT_LEDGER)},
         modelVersion: ${JSON.stringify(c.model)},${extraOpts}
       });
       process.stdout.write(JSON.stringify({ threw: false, result }));
     } catch (err) {
       process.stdout.write(JSON.stringify({
         threw: true,
         code: err && err.code ? err.code : null,
         message: err && err.message ? err.message : String(err),
       }));
     }`,
    liveRootEnv(c.fakeHome, {
      MEMORY_ROOT: c.other,
      STORAGE_BASE_DIR: join(c.other, "storage"),
    }),
  );
}

/** The thrown message carried back by a runAliasedLib probe child. */
function probeMessage(proc) {
  return JSON.parse((proc.stdout || "").trim()).message;
}

// R1 — the name=TRUE row. --target=active resolves the ACTIVE model, so the
// NAME compare is true; what changes the verdict is that the identity term is
// no longer conjoined with the argument-presence proxy.
await test("r5 — an aliased destination under a CONTAINED root is refused (CLI)", () => {
  const c = seedAliasedRootCase("r5-alias-cli", aliasServedAt(ACTIVE_MODEL));
  assertAliasedPreconditions(c);

  const proc = runAliasedCli(c, ["--target=active"]);

  assertCliRefused(c, proc);
  assertOtherRootPristine(c);
  // The remedy sentence must be true of THIS run: the operator already passed
  // a temp root, so "re-run with --memory-root=<TEMPDIR>" would be false advice.
  assert.ok(
    proc.stderr.includes(join(c.other, "indices", ACTIVE_MODEL)),
    `stderr names the MEASURED destination; got: ${proc.stderr}`,
  );
  assert.match(proc.stderr, /is NOT the live root/);
});

// R2 — the same shape at the LIBRARY seam, which the CLI cannot stand in for:
// a caller that never goes through the script must hit its own refusal.
await test("r5 — an aliased destination under a CONTAINED MEMORY_ROOT is refused (LIBRARY)", () => {
  const c = seedAliasedRootCase("r5-alias-lib", aliasServedAt(ACTIVE_MODEL));
  assertAliasedPreconditions(c);

  const proc = runAliasedLib(c);

  assertLibRefused(c, proc);
  assertOtherRootPristine(c);
  assert.match(probeMessage(proc), new RegExp(ACTIVE_MODEL));
});

// R3 — the name=FALSE row. The publish target is not spelled like the ACTIVE
// model, and no --allow-live-tree is given, so nothing but the DESTINATION
// measurement can produce this refusal. Pre-fix this ran exit 0 and clobbered.
await test("r5 — the refusal comes from the identity term alone (name=false, CLI)", () => {
  const alias = `${ACTIVE_MODEL}-alias`;
  const c = seedAliasedRootCase("r5-alias-namefalse", aliasServedAt(alias));
  assert.notEqual(c.model, ACTIVE_MODEL, "the publish target is NOT the ACTIVE name");
  assertAliasedPreconditions(c);

  const proc = runAliasedCli(c, [`--model-version=${c.model}`]);

  assertCliRefused(c, proc);
  assertOtherRootPristine(c);
});

// ---- FALSIFICATION WITH ALIASES THE IMPLEMENTATION DOES NOT ENUMERATE ------
// All at the contained, non-live `<other>` root; all must exit 2 with the
// sentinel byte-identical. HARDLINKED DIRECTORY is deliberately ABSENT: the
// "a hardlinked directory is not constructible on this volume" case above
// already records that shape as untestable, and duplicating it here would be
// false coverage.

await test("r5 — a trailing-slash MODEL VERSION at a contained root is refused", () => {
  const c = seedAliasedRootCase("r5-alias-slash", (s, other) => {
    symlinkSync(s.dir, join(other, "indices", ACTIVE_MODEL));
    return `${ACTIVE_MODEL}/`;
  });
  assertAliasedPreconditions(c);
  assertCliRefused(c, runAliasedCli(c, [`--model-version=${c.model}`]));
  assertOtherRootPristine(c);
});

await test("r5 — a ..-traversal MODEL VERSION at a contained root is refused", () => {
  const c = seedAliasedRootCase("r5-alias-dotdot", (s, other) => {
    symlinkSync(s.dir, join(other, "indices", ACTIVE_MODEL));
    return `${ACTIVE_MODEL}/../${ACTIVE_MODEL}`;
  });
  assertAliasedPreconditions(c);
  assertCliRefused(c, runAliasedCli(c, [`--model-version=${c.model}`]));
  assertOtherRootPristine(c);
});

await test("r5 — a case-variant MODEL VERSION at a contained root is refused", () => {
  assert.equal(caseFoldsHere(), true, "precondition: TMPDIR family case-folds");
  const c = seedAliasedRootCase("r5-alias-case", (s, other) => {
    symlinkSync(s.dir, join(other, "indices", ACTIVE_MODEL));
    return ACTIVE_MODEL.toUpperCase();
  });
  assert.notEqual(c.model, ACTIVE_MODEL, "the spelling differs from the ACTIVE name");
  assertAliasedPreconditions(c);
  assertCliRefused(c, runAliasedCli(c, [`--model-version=${c.model}`]));
  assertOtherRootPristine(c);
});

await test("r5 — a trailing-slash --memory-root at an aliased destination is refused", () => {
  const c = seedAliasedRootCase("r5-alias-rootslash", aliasServedAt(ACTIVE_MODEL));
  assertAliasedPreconditions(c);

  const proc = runCli(
    ["--target=active", `--memory-root=${c.other}/`],
    liveRootEnv(c.fakeHome),
  );

  assertCliRefused(c, proc);
  assertOtherRootPristine(c);
});

await test("r5 — a cwd-relative --memory-root at an aliased destination is refused", () => {
  const c = seedAliasedRootCase("r5-alias-relative", aliasServedAt(ACTIVE_MODEL));
  assertAliasedPreconditions(c);

  const proc = runCli(
    ["--target=active", `--memory-root=${basename(c.other)}`],
    liveRootEnv(c.fakeHome),
    dirname(c.other),
  );

  assertCliRefused(c, proc);
  assertOtherRootPristine(c);
});

// THE FIRMLINK COMPOSITION CONTROL. Firmlinks are an APFS volume feature and
// cannot be constructed under TMPDIR, so the only honest coverage is to OBSERVE
// the host's spelling. It is the COMPOSITION that is under test, not either
// predicate: the pair (isServedIndexTree === true, isLiveIndexRoot === false)
// is exactly the input the old composition discarded, and the firmlink spelling
// reaches it.
//
// THIS IS THE ONLY CASE IN THIS FILE WHOSE SYMLINK POINTS OUTSIDE TMP_ROOT, at
// the REAL served directory, so its safety is spelled out rather than assumed:
//   - PURE READS. It calls two predicates and runs no rebuild at either seam.
//     Nothing is ever written under the real memory-system tree.
//   - The link is unlinked in a `finally`, so the file's exit-time
//     rmSync(TMP_ROOT, {recursive:true}) never even sees it. (MEASURED
//     separately that rmSync does NOT follow directory symlinks — it unlinks
//     them — but a control that reads the live system should not lean on that.)
//   - The real served bm25.json is asserted present afterwards, so a future
//     edit that turned this case into a writer would fail here rather than
//     quietly damage the production index.
await test("r5 — the firmlink spelling composes to (served=true, live=false)", async (t) => {
  const servedViaFirmlink = join(REAL_FIRMLINK, "indices", ACTIVE_MODEL);
  const realServedIndex = join(REAL_LIVE_ROOT, "indices", ACTIVE_MODEL, "bm25.json");
  if (!existsSync(REAL_LIVE_ROOT) || !existsSync(servedViaFirmlink)) {
    t.skip("host has no firmlink spelling of the served index directory");
    return;
  }
  const { isLiveIndexRoot, isServedIndexTree } = await import(
    "../lib/recall/bm25-rebuild.js"
  );

  const composed = join(TMP_ROOT, "r5-firmlink-compose");
  mkdirSync(join(composed, "indices"), { recursive: true, mode: 0o700 });
  const link = join(composed, "indices", ACTIVE_MODEL);
  symlinkSync(servedViaFirmlink, link);
  try {
    assert.equal(
      isServedIndexTree(composed, ACTIVE_MODEL),
      true,
      "the firmlink spelling reads as the served index directory",
    );
    assert.equal(
      isLiveIndexRoot(composed),
      false,
      "…while the temp root that reaches it reads as NOT live — the pair the " +
        "old composition threw away",
    );
  } finally {
    unlinkSync(link);
  }
  assert.equal(
    existsSync(realServedIndex),
    true,
    "the real served index is untouched — this control only ever read",
  );
});

// ---- POSITIVE CONTROLS, so a blanket-refuse implementation cannot pass -----

// P1. The discriminator for "IDENTITY, not mere existence". Newly load-bearing:
// the library now runs isServedIndexTree on EVERY unarmed non-dry rebuild, so
// an implementation that refused whenever the destination merely EXISTS would
// break every legitimate repeat rebuild into a scratch root.
await test("r5 P1 — a contained root whose indices/<ACTIVE> is a REAL directory still publishes", () => {
  const fakeHome = join(TMP_ROOT, "r5-p1-home");
  const sentinel = seedSentinel(fakeHome);
  const outRoot = join(TMP_ROOT, "r5-p1-out");
  const realDir = join(outRoot, "indices", ACTIVE_MODEL);
  mkdirSync(realDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(realDir, "bm25.json"), '{"its":"own"}\n');
  // PRECONDITION, in two halves, so the case cannot pass vacuously: the
  // destination really does EXIST as a real directory holding its own index,
  // and the library's own predicate still answers "not the served tree" about
  // it. Together they are the discriminator — IDENTITY decides, not existence.
  assert.equal(existsSync(join(realDir, "bm25.json")), true, "it really exists");
  const pair = measureGuardPair(fakeHome, outRoot, ACTIVE_MODEL);
  assert.equal(pair.served, false, "…and it is NOT the served directory");
  assert.equal(pair.live, false, "…under a root that is not the live one");

  const proc = runCli(
    ["--target=active", `--memory-root=${outRoot}`],
    liveRootEnv(fakeHome),
  );

  assert.equal(
    proc.status,
    0,
    `an existing REAL destination publishes (stderr: ${proc.stderr})`,
  );
  const env = envelopeOf(proc);
  assert.equal(env.wrote_index, true);
  assert.equal(env.bm25_path, join(realDir, "bm25.json"));
  assertLiveTreeIntact(sentinel);
});

// P2. The guard is about WRITES. --dry-run at the aliased destination is still
// a legal, useful operation and must stay exit 0 with the sentinel intact.
await test("r5 P2 — --dry-run at the aliased destination still exits 0 and writes nothing", () => {
  const c = seedAliasedRootCase("r5-p2-dryrun", aliasServedAt(ACTIVE_MODEL));
  assertAliasedPreconditions(c);

  const proc = runAliasedCli(c, ["--target=active", "--dry-run"]);

  assert.equal(proc.status, 0, `dry run exits 0 (stderr: ${proc.stderr})`);
  const env = envelopeOf(proc);
  assert.equal(env.wrote_index, false);
  assert.equal(
    sha256Of(c.sentinel.bm25Path),
    c.sentinel.digest,
    "the stand-in served bm25.json is byte-identical",
  );
  assert.deepEqual(treeListing(c.sentinel.root), c.before, "zero treeListing delta");
});

// P3. ARMING IS PROVEN LIVE, NOT ASSUMED. `allowLiveTreePublish !== true` is a
// PRECONDITION of the hoisted measurement, so an armed caller must not merely
// avoid the throw — it must still WRITE. The digest CHANGE is that proof.
await test("r5 P3 — allowLiveTreePublish:true still publishes at the aliased destination", () => {
  const c = seedAliasedRootCase("r5-p3-armed", aliasServedAt(ACTIVE_MODEL));
  assertAliasedPreconditions(c);

  const proc = runAliasedLib(c, "\n         allowLiveTreePublish: true,");

  assert.equal(proc.status, 0, `the probe child ran (stderr: ${proc.stderr})`);
  const out = JSON.parse((proc.stdout || "").trim());
  assert.equal(out.threw, false, `arming must NOT throw, got ${out.message}`);
  assert.equal(out.result.wrote_index, true, "an armed run actually publishes");
  assert.notEqual(
    sha256Of(c.sentinel.bm25Path),
    c.sentinel.digest,
    "…and the write LANDED: the stand-in served bm25.json digest changed",
  );
});

// ---- THE RESIDUAL, MEASURED RATHER THAN ASSERTED --------------------------
// A non-live root whose SIBLING (non-served) model-version child symlinks under
// the live root. isServedIndexTree measures the SERVED directory only, so it
// answers false here; isLiveIndexRoot(<other>) is false; nothing refuses.
// PERMIT BEFORE and PERMIT AFTER — recorded as a residual, not closed. Closing
// it needs an "is the destination anywhere under the live root" predicate, i.e.
// a THIRD containment rule, and two copies of a containment rule is how the
// original bypass came to exist.
await test("r5 residual — a SIBLING model-version child symlinked under the live root still publishes", () => {
  const typo = `${ACTIVE_MODEL}-typo`;
  const fakeHome = join(TMP_ROOT, "r5-residual-home");
  const sentinel = seedSentinel(fakeHome);
  const liveSibling = join(sentinel.root, "indices", typo);
  mkdirSync(liveSibling, { recursive: true, mode: 0o700 });
  writeFileSync(join(liveSibling, "bm25.json"), SENTINEL_BYTES);
  const siblingDigest = sha256Of(join(liveSibling, "bm25.json"));
  const other = join(TMP_ROOT, "r5-residual-other");
  mkdirSync(join(other, "indices"), { recursive: true, mode: 0o700 });
  symlinkSync(liveSibling, join(other, "indices", typo));

  const pair = measureGuardPair(fakeHome, other, typo);
  assert.equal(pair.served, false, "the SERVED directory is not what this aliases");
  assert.equal(pair.live, false, "and the root is not the live one");

  const proc = runCli(
    [`--model-version=${typo}`, `--memory-root=${other}`],
    liveRootEnv(fakeHome),
  );

  // PERMIT — the honest record of what this node does NOT close.
  assert.equal(proc.status, 0, `still publishes (stderr: ${proc.stderr})`);
  assert.equal(envelopeOf(proc).wrote_index, true);
  assert.notEqual(
    sha256Of(join(liveSibling, "bm25.json")),
    siblingDigest,
    "the sibling under the live root WAS rewritten — this is the residual",
  );
  // The SERVED index is untouched, which is why this is a residual rather than
  // a regression of r4 / r4-b1.
  assert.equal(
    sha256Of(sentinel.bm25Path),
    sentinel.digest,
    "the served bm25.json is byte-identical — the served guard still holds",
  );
});

// ---- MONOTONICITY AS AN EXECUTABLE CASE, not prose ------------------------
// Booleans only: no filesystem, no spawn. OLD and NEW are transcribed from the
// two compositions and evaluated over ALL 32 assignments of each seam's own
// inputs. "Nothing refused before may be permitted after" is checked as
// `old => new` on every row, and the set of rows where they differ is pinned
// EXACTLY, so a future widening cannot hide inside "it still tightens".
await test("r5 — monotone tightening: old => new on all 32 rows, diff sets pinned", () => {
  const BOOLS = [false, true];
  const sweep = (keys) => {
    let rows = [{}];
    for (const k of keys) {
      rows = rows.flatMap((r) => BOOLS.map((v) => ({ ...r, [k]: v })));
    }
    return rows;
  };

  // ---- CLI served refusal -------------------------------------------------
  // OLD: (name || ident) && !dry && (absent || live)
  // NEW: !dry && (ident || (name && (absent || live)))
  const cliRows = sweep(["ident", "name", "present", "live", "dry"]);
  assert.equal(cliRows.length, 32, "all 32 CLI assignments");
  const uncontained = (r) => !r.present || r.live;
  const cliOld = (r) => (r.name || r.ident) && !r.dry && uncontained(r);
  const cliNew = (r) => !r.dry && (r.ident || (r.name && uncontained(r)));

  const cliDiff = [];
  for (const r of cliRows) {
    const o = cliOld(r);
    const n = cliNew(r);
    assert.ok(!o || n, `CLI monotonicity violated at ${JSON.stringify(r)}`);
    if (o !== n) {
      assert.equal(o, false, "every differing CLI row is permit -> refuse");
      cliDiff.push(r);
    }
  }
  assert.deepEqual(
    cliDiff
      .map((r) => `ident=${r.ident} name=${r.name} present=${r.present} live=${r.live} dry=${r.dry}`)
      .sort(),
    [
      "ident=true name=false present=true live=false dry=false",
      "ident=true name=true present=true live=false dry=false",
    ],
    "the CLI diff set is exactly {destinationIsServed:true, " +
      "memoryRootPresent:true, liveTree:false, dryRun:false}, name free",
  );

  // ---- LIBRARY served refusal --------------------------------------------
  // OLD: !dry && !armed && live && (name || ident)
  // NEW: !dry && !armed && (ident || (live && name))
  const libRows = sweep(["ident", "name", "live", "dry", "armed"]);
  assert.equal(libRows.length, 32, "all 32 LIBRARY assignments");
  const libOld = (r) => !r.dry && !r.armed && r.live && (r.name || r.ident);
  const libNew = (r) => !r.dry && !r.armed && (r.ident || (r.live && r.name));

  const libDiff = [];
  for (const r of libRows) {
    const o = libOld(r);
    const n = libNew(r);
    assert.ok(!o || n, `LIB monotonicity violated at ${JSON.stringify(r)}`);
    if (o !== n) {
      assert.equal(o, false, "every differing LIB row is permit -> refuse");
      libDiff.push(r);
    }
  }
  assert.deepEqual(
    libDiff
      .map((r) => `ident=${r.ident} name=${r.name} live=${r.live} dry=${r.dry} armed=${r.armed}`)
      .sort(),
    [
      "ident=true name=false live=false dry=false armed=false",
      "ident=true name=true live=false dry=false armed=false",
    ],
    "the LIBRARY diff set is exactly {ident:true, live:false, dry:false, " +
      "armed:false}, name free",
  );

  // ---- THE SIBLING ARM MOVES NOT AT ALL ----------------------------------
  // Its entry condition is textually unchanged in BOTH sources — `!targetsServed
  // && !dryRun && liveTree` at the CLI, `!targetsServed` inside the live block
  // at the library — and `targetsServed` keeps the FULL disjunction. So the
  // only way it could move is by the served refusal stealing a row from it or
  // yielding one to it. That REACHABILITY-guarded form is what is asserted
  // here, on every row, at both seams; a vacuous restatement of an identical
  // expression would prove nothing.
  const targetsServed = (r) => r.name || r.ident;
  for (const r of cliRows) {
    const entry = !targetsServed(r) && !r.dry && r.live;
    assert.equal(
      !cliOld(r) && entry,
      !cliNew(r) && entry,
      `CLI sibling-arm reachability moved at ${JSON.stringify(r)}`,
    );
  }
  for (const r of libRows) {
    const entry = !r.dry && !r.armed && r.live && !targetsServed(r);
    assert.equal(
      !libOld(r) && entry,
      !libNew(r) && entry,
      `LIB sibling-arm reachability moved at ${JSON.stringify(r)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 6. --coverage. The unit is a PERCENT: a 10-row all-eligible fixture that is
// fully indexed reports 100, NOT 1. (mcp/lib/synthesis/coverage-probe.js's
// pct() returns a fraction and is deliberately not the probe used here.)
// ---------------------------------------------------------------------------
await test("--coverage reports coverage_pct as a PERCENT with stamped units", () => {
  const outRoot = join(TMP_ROOT, "out-coverage");
  const proc = runCli(
    ["--target=active", `--memory-root=${outRoot}`, "--coverage"],
    baseEnv(),
  );
  assert.equal(proc.status, 0, `CLI exit 0 (stderr: ${proc.stderr})`);
  const env = envelopeOf(proc);

  assert.equal(env.indexed_docs, FIXTURE_ROWS);
  assert.equal(env.eligible_rows, FIXTURE_ROWS);
  assert.equal(env.coverage_pct, 100, "PERCENT in [0,100], not a fraction");
  assert.equal(env.numerator_unit, "distinct_doc_ids");
  assert.equal(env.denominator_unit, "eligible_lines");
  assert.equal(env.coverage_pct_unit, "percent");
  assert.equal(env.coverage_error, null);
});

await test("--dry-run --coverage emits null coverage keys, never fabricated ones", () => {
  const proc = runCli(["--target=active", "--dry-run", "--coverage"], baseEnv());
  assert.equal(proc.status, 0, `CLI exit 0 (stderr: ${proc.stderr})`);
  const env = envelopeOf(proc);
  assert.equal(env.wrote_index, false);
  for (const key of [
    "indexed_docs",
    "eligible_rows",
    "coverage_pct",
    "numerator_unit",
    "denominator_unit",
    "coverage_pct_unit",
    "coverage_error",
  ]) {
    assert.ok(key in env, `${key} present`);
    assert.equal(env[key], null, `${key} is null on a dry run`);
  }
});

// A probe failure is NOT a build failure. The index was written; only the
// measurement is missing. Exit 3, envelope still printed, coverage keys null
// plus coverage_error. (Induced with a ledger whose rows carry an id but no
// content: BM25-eligible rows = 0, so probeBm25Coverage refuses the empty
// denominator rather than reporting a fake ratio.)
await test("a --coverage probe failure prints the envelope and exits 3", () => {
  const ledgerDir = join(TMP_ROOT, "ledgers-ineligible");
  mkdirSync(ledgerDir, { recursive: true, mode: 0o700 });
  const ledgerPath = join(ledgerDir, "memory.jsonl");
  writeFileSync(
    ledgerPath,
    [
      JSON.stringify({ id: "mem_no_content_a", kind: "fact" }),
      JSON.stringify({ id: "mem_no_content_b", kind: "fact", content: "" }),
    ].join("\n") + "\n",
  );

  const outRoot = join(TMP_ROOT, "out-probe-fail");
  const proc = runCli(
    ["--target=active", `--memory-root=${outRoot}`, "--coverage"],
    baseEnv({ LEDGERS_BASE_DIR: ledgerDir }),
  );
  assert.equal(proc.status, 3, `exit 3 (stderr: ${proc.stderr})`);
  const env = envelopeOf(proc);
  assert.equal(env.wrote_index, true, "the build itself succeeded");
  assert.ok(existsSync(env.bm25_path), "the index is on disk");
  assert.equal(env.coverage_pct, null);
  assert.equal(env.indexed_docs, null);
  assert.match(env.coverage_error, /probe_ledger_no_eligible_rows/);
});
