// bm25-rebuild.js — WU-RR1-bm25-rebuild.
//
// One-shot full rebuild of the BM25 inverted index from the canonical
// memory.jsonl ledger. Streams the ledger (never loads the whole file into
// memory) and writes the resulting Bm25Index.serialize() blob to
// indices/<modelVersion>/bm25.json atomically (tmp + rename).
//
// PROBLEM (why this exists):
//   The BM25 index at indices/gemini-embedding-001/bm25.json is updated
//   incrementally by distill-promote-fact.js (bm25.add() + saveIndices on
//   every PROMOTE). Several historical regressions left the on-disk index
//   weeks behind the ledger:
//     - The promote-time saveIndices path can fail mid-flight (ENOSPC,
//       perm error, transient FS issue) and the inconsistency is silent.
//     - Backfill batches that bypass distill-promote-fact (operator hand-
//       runs, scripts) never call bm25.add and never trigger saveIndices.
//     - A torn write or a corrupted JSON load deserializes to an empty
//       Bm25Index (per index-cache.js's "fall back to empty" branch), so
//       subsequent promotes only build the index from-that-promote-forward.
//
// FIX:
//   A periodic full rebuild from the source-of-truth ledger guarantees the
//   index reflects every fact, regardless of any incremental drift. The
//   script form runs ad-hoc; the daemon trigger fires when N facts have
//   been added since the last rebuild (CAPS.BM25_REBUILD_THRESHOLD).
//
// DISCIPLINE:
//   - Uses streamLedgerLines (synthesis/_ledger-stream.js) so memory stays
//     bounded by the in-memory Bm25Index, NOT by the ledger size. The
//     index itself is per-doc-len Map + posting Maps; for a 1.4M-row
//     ledger, the resulting structure is sized by the unique-token count,
//     not the line count, but the streaming step never holds more than
//     one parsed row in scope.
//   - Atomic write: serialize -> write tmp -> rename(tmp, target). The
//     pre-existing saveIndices in index-cache.js writes both BM25 + HNSW
//     together; we deliberately split here so a BM25 rebuild does NOT
//     touch hnsw.bin (rebuilding HNSW from scratch requires the embedding
//     vectors and is a much heavier operation handled separately).
//   - Defensive: a single malformed ledger line is silently skipped by
//     streamLedgerLines's JSON.parse catch. A row without a string `id`
//     or `content` is also skipped (counted in `rows_skipped`). Any
//     unexpected throw from the writer is propagated so the caller can
//     log + leave the old index in place (the daemon's trigger wraps
//     this in try/catch with that exact discipline).
//   - Per-version path: indices live under indices/<modelVersion>/ and we
//     never write into a different model version's tree. With every
//     rebuild-target flag off the target is CAPS.ACTIVE_EMBED_MODEL_VERSION
//     (l11 — see _defaultRebuildModelVersion for the full precedence and for
//     why the argument-less default no longer names the legacy Gemini key).
//     B2's model-neutral flag selects a side-by-side generation under
//     indices/_lexical/. Callers may always pass an explicit model.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  // r4 — the live-root predicate below compares DIRECTORY IDENTITY (dev+ino
  // from statSync, which follows symlinks) rather than path strings; see
  // _dirIdentityNearestExisting for why neither resolve() nor realpathSync()
  // was enough. lstatSync is there only to tell a dangling symlink (an alias
  // that cannot be followed, so cannot be measured) apart from a plain absent
  // component.
  lstatSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  CHECKOUT_ROOT,
  MEMORY_ROOT,
  memoryLedgerPath,
  STORAGE_DIR,
} from "../config.js";
import { streamLedgerLines } from "../synthesis/_ledger-stream.js";
// W2 (memperf) — S1 checkpoint substrate for the O(delta) growth check:
// countFactRowsCheckpointed replaces the full-ledger stream in the daemon
// trigger with a persisted {checkpoint, fact_count} sidecar advanced by
// counting ONLY appended rows (full recount only on prefix-identity failure).
import {
  captureCheckpoint,
  deserializeCheckpoint,
  emptyCheckpoint,
  readAppended,
  serializeCheckpoint,
  verifyPrefix,
} from "../synthesis/ledger-checkpoint.js";
import { CAPS } from "../validation.js";
import { Bm25Index } from "./bm25-index.js";
import { buildContextPrefix } from "./context-prefix.js";
// WU-backward-conversation-index — the contextual-BM25 prefix resolves a REAL
// thread label for historical facts (provenance.conversation_id === null) by
// LEFT-JOINING this derived projection. Loaded once per rebuild; absent /
// unbuilt -> buildContextPrefix degrades to the on-row resolution (current
// behavior). Never mutates fact rows (thesis #1).
import {
  loadConversationIndexFromCacheSync,
  lookupConversation,
} from "../synthesis/conversation-index.js";

// S3 FIX CYCLE 2 — the rebuild's publication now goes through index-cache.js
// publishGeneration (see the write site below). The import is circular
// (index-cache.js imports writeBm25IndexV2Atomic from here) but safe: both
// directions bind hoisted function declarations that are only CALLED at
// runtime, never during module evaluation.
import { publishGeneration } from "./index-cache.js";
import {
  LEXICAL_INDEX_KEY,
  activateBm25Projection,
  isModelNeutralBm25Enabled,
} from "./bm25-projection.js";

export const BM25_REBUILD_TARGET_ACTIVE_FLAG =
  "MEMORY_BM25_REBUILD_TARGET_ACTIVE";
// l11 — explicit opt-IN to the legacy tree. The former default is now an
// escape hatch: the argument-less default resolves the ACTIVE model, so
// nothing reaches indices/<legacy>/ unless an operator asks for it by name.
export const BM25_REBUILD_TARGET_LEGACY_FLAG =
  "MEMORY_BM25_REBUILD_TARGET_LEGACY";
export const BM25_REBUILD_OBJECT_ENTITIES_FLAG =
  "MEMORY_BM25_REBUILD_OBJECT_ENTITIES";

// l11 — THE module's single reference to the legacy Gemini model id. Every
// legacy-target decision below goes through this symbol so the downstream
// purge that deletes the CAPS key is a ONE-LINE edit here, not a hunt for
// scattered call sites. When that key goes away this evaluates to undefined
// and `_defaultRebuildModelVersion()` degrades to the ACTIVE model (see the
// non-empty-string guard there) rather than emitting an empty path component.
export const BM25_REBUILD_LEGACY_MODEL_VERSION =
  CAPS.GEMINI_EMBEDDING_MODEL_DEFAULT;

/**
 * Logical target for an argument-less rebuild. Read the opt-ins at CALL TIME so
 * tests and long-lived daemons do not capture an import-time environment.
 * Explicit opts.modelVersion values are resolved by each caller before this
 * helper is consulted.
 *
 * Precedence (each flag matched EXACTLY against "1"; "true" is not truthy):
 *   1. MEMORY_BM25_REBUILD_TARGET_LEGACY=1 -> the legacy Gemini tree.
 *   2. MEMORY_BM25_REBUILD_TARGET_ACTIVE=1 -> the ACTIVE model. Retained as a
 *      no-op-compatible alias of the new default so existing callers that set
 *      it keep working.
 *   3. MEMORY_BM25_MODEL_NEUTRAL=1          -> the `_lexical` projection.
 *   4. (default)                            -> the ACTIVE model.
 *
 * l11 flipped step 4. It used to be the legacy tree, which meant the
 * watermark daemon's argument-less periodic rebuild re-created
 * indices/<legacy>/ through publishGeneration's unconditional mkdir after any
 * operator deleted it.
 */
export function _defaultRebuildModelVersion() {
  if (
    process.env[BM25_REBUILD_TARGET_LEGACY_FLAG] === "1" &&
    typeof BM25_REBUILD_LEGACY_MODEL_VERSION === "string" &&
    BM25_REBUILD_LEGACY_MODEL_VERSION.length > 0
  ) {
    return BM25_REBUILD_LEGACY_MODEL_VERSION;
  }
  if (process.env[BM25_REBUILD_TARGET_ACTIVE_FLAG] === "1") {
    return CAPS.ACTIVE_EMBED_MODEL_VERSION;
  }
  return isModelNeutralBm25Enabled()
    ? LEXICAL_INDEX_KEY
    : CAPS.ACTIVE_EMBED_MODEL_VERSION;
}

/**
 * resolvePublishModelVersion — map a LOGICAL rebuild target onto the PHYSICAL
 * index tree it actually publishes into.
 *
 * `_lexical` is a PROJECTION, not a dense-model tree, so it cannot self-source:
 * activateBm25Projection throws bm25_projection_bad_arguments when handed
 * LEXICAL_INDEX_KEY as sourceModelVersion. The rebuild therefore publishes
 * through a dense model's generation publisher and then activates an immutable
 * neutral member from that generation. Every other target is its own tree.
 *
 * THIS IS THE ONLY DEFINITION OF THAT REDIRECT. It used to be an inline
 * ternary inside rebuildBm25IndexFromLedger, which meant the CLI's live-tree
 * write guard compared the LOGICAL name against the ACTIVE model and waved
 * `_lexical` straight through into the ACTIVE model's served tree. A second
 * copy of this rule is how that bug happened; callers that need to know where
 * a target LANDS must import this symbol rather than re-derive it.
 *
 * @param {string} modelVersion logical target
 * @returns {string} the model-version tree the publish physically lands in
 */
export function resolvePublishModelVersion(modelVersion) {
  return modelVersion === LEXICAL_INDEX_KEY
    ? CAPS.ACTIVE_EMBED_MODEL_VERSION
    : modelVersion;
}

/**
 * _dirIdentityNearestExisting — measure the DIRECTORY IDENTITY a path names,
 * even when its tail does not exist yet.
 *
 * MEASURED REASON this is not a string comparison: on the production host
 * `<HOME>/memory-system`, `<HOME>/MEMORY-SYSTEM` (case-insensitive
 * APFS) and `/System/Volumes/Data<HOME>/memory-system` (firmlink) are ONE
 * directory — identical dev+ino — yet realpathSync returns each spelling back
 * verbatim, so a realpath-string compare called two of the three "not the live
 * root". dev+ino is the filesystem's own answer to "same directory?", and it
 * is blind to the aliasing mechanism that produced the extra spelling.
 *
 * The tail is frequently absent — the guard runs BEFORE any write, so the
 * indices/ directory it is asked about often does not exist yet. Walk up to the
 * nearest existing ancestor, stat THAT, and report the segments consumed on the
 * way as `residual`. Two paths name one directory iff their nearest existing
 * ancestors are the same directory AND their residual tails are identical.
 * Without the residual, every not-yet-existing path under a shared ancestor
 * (two sibling temp roots under TMPDIR) would compare equal.
 *
 * bigint:true because APFS inodes are 64-bit: the non-bigint `ino` field is a
 * double and silently loses precision above 2^53.
 *
 * PURE READS. This function must never create a directory: the live-root guard
 * calls it before deciding to refuse, and a refused run has to leave the root
 * it refused byte-identical (bm25-full-rebuild.test.mjs case 5 asserts the
 * refusal created nothing under the resolved live root).
 *
 * FAIL CLOSED on every unresolvable state — an unmeasurable path must never
 * produce a positive permit (its caller turns a throw into REFUSE):
 *   - ENOENT / ENOTDIR are the only "keep walking" signals (ENOTDIR when some
 *     ancestor is a regular file);
 *   - any other stat error (EACCES, EIO, ELOOP) propagates;
 *   - reaching the filesystem root without a successful stat THROWS rather
 *     than falling back to the lexical path — an unstattable root is
 *     unmeasurable, not permitted;
 *   - a component that lstat()s but does not stat() is a DANGLING SYMLINK, an
 *     alias whose target cannot be measured, so it THROWS rather than being
 *     walked past as if it were simply absent.
 *
 * @param {string} p path to measure
 * @returns {{dev: bigint, ino: bigint, residual: string[]}} identity of the
 *   nearest existing ancestor plus the not-yet-existing tail below it
 */
export function _dirIdentityNearestExisting(p) {
  let cursor = resolve(p);
  const residual = [];
  for (;;) {
    try {
      const st = statSync(cursor, { bigint: true });
      return { dev: st.dev, ino: st.ino, residual };
    } catch (err) {
      const code = err && err.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      if (code === "ENOENT") {
        // stat() failed but the entry itself is there => dangling symlink.
        let dangling = true;
        try {
          lstatSync(cursor);
        } catch {
          dangling = false;
        }
        if (dangling) {
          const e = new Error(
            `cannot measure directory identity of ${cursor}: dangling symlink`,
          );
          e.code = "bm25_dir_identity_dangling_symlink";
          throw e;
        }
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        // Filesystem root and still nothing stattable. Unmeasurable => refuse.
        const e = new Error(
          `cannot measure directory identity of ${resolve(p)}: reached the ` +
            "filesystem root without a stattable ancestor",
        );
        e.code = "bm25_dir_identity_unmeasurable";
        throw e;
      }
      residual.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * isLiveIndexRoot — does a MEMORY_ROOT candidate publish into the SAME physical
 * index directory the running queryd serves?
 *
 * The comparison is on `<root>/indices` rather than on the root itself, because
 * indices/ is the directory that actually gets WRITTEN. Comparing the written
 * directory subsumes root equality (equal roots give equal indices children
 * under the ancestor walk) and additionally catches a root whose `indices`
 * child is itself a symlink into the live tree — a root-only test would wave
 * that straight through.
 *
 * BOTH sides are measured as directory identity (dev+ino of the nearest
 * existing ancestor, plus the not-yet-existing tail). Measuring only the
 * candidate would still miss the case where the live root is reached through an
 * aliased HOME.
 *
 * The reference side is join(homedir(), HOME_INSTALL_DIRNAME, "indices") on
 * purpose (first entry of _liveRootReferences()) and must stay that: HOME is the only
 * root selector the hermetic suite has, and config.js's MEMORY_ROOT is the
 * env-overridable value this predicate
 * exists to VALIDATE — deriving the reference from it would compare a value
 * against itself.
 *
 * ADDITIVE second reference: config.js's CHECKOUT_ROOT (the checkout that
 * contains mcp/, env-independent). Since the default data root is the
 * checkout, a relocated install's live index lives at <checkout>/indices and
 * no longer under HOME; a candidate matching EITHER reference is live. This
 * only ever adds refusals — the home reference is unchanged, and CHECKOUT_ROOT
 * is not env-overridable, so it is not the value under validation either.
 *
 * FAIL CLOSED: on any resolution error the predicate returns TRUE, i.e. toward
 * refusal. The costs are asymmetric — a false refusal costs one rebuild that
 * must be re-pointed at a temp root, while a false permit clobbers the index a
 * live queryd is serving.
 *
 * @param {string} candidateRoot a MEMORY_ROOT-shaped path
 * @returns {boolean} true when a publish under candidateRoot lands in the live
 *   index tree, or when that question could not be answered
 */
export function isLiveIndexRoot(candidateRoot) {
  try {
    const candidate = _dirIdentityNearestExisting(join(candidateRoot, "indices"));
    return _liveRootReferences().some((root) =>
      _sameDirIdentity(candidate, _dirIdentityNearestExisting(join(root, "indices"))),
    );
  } catch {
    return true;
  }
}

/**
 * Directory name of the conventional home-directory install. This is NOT a
 * data-root default (lib/config.js owns that; the default root is the
 * checkout): it is only the name of the first live-root REFERENCE below, i.e.
 * a place a rebuild must refuse to publish into. Same value as before, named.
 */
const HOME_INSTALL_DIRNAME = "memory-system";

/**
 * The reference roots both live-tree predicates measure against. The home
 * reference comes first and is unchanged; CHECKOUT_ROOT is the additive one.
 * Neither is derived from the env-overridable MEMORY_ROOT.
 */
function _liveRootReferences() {
  return [join(homedir(), HOME_INSTALL_DIRNAME), CHECKOUT_ROOT];
}

/** The four-term directory-identity comparison shared by both predicates. */
function _sameDirIdentity(a, b) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.residual.length === b.residual.length &&
    a.residual.every((seg, i) => seg === b.residual[i])
  );
}

/**
 * isServedIndexTree — does a (root, publishModelVersion) pair land in the SAME
 * physical directory the running queryd serves?
 *
 * isLiveIndexRoot answers "is this the live ROOT?". This answers the question
 * one level down — "is this the SERVED TREE inside it?" — which the guard used
 * to decide with a string compare, `publishModelVersion ===
 * CAPS.ACTIVE_EMBED_MODEL_VERSION`. A model version is a PATH COMPONENT:
 * `indices/<publishModelVersion>` is the directory publishGeneration writes
 * (index-cache.js indicesDir() + indexPathsFor()). So every aliasing mechanism
 * that defeated the root-level string compare defeats the name-level one too.
 *
 * MEASURED, in a stand-in live root under TMP, before this predicate existed —
 * each shape armed through the SIBLING arm (which the string compare routed it
 * to, because the alias is not spelled like the ACTIVE model) and each one
 * published straight over the served index, exit 0, empty stderr, seeded
 * bm25.json sha256 35f8339f… -> 54e3c1bb…, bm25.gen-0.json created, at BOTH
 * the CLI (`--allow-live-tree=<alias>`) and library
 * (`allowLiveTreeSiblingPublish:true`) seams:
 *   - `QWEN3-EMBEDDING-8B-FP16`  (case variant, case-insensitive volume)
 *   - `<active>-alias`           (a symlink to the served directory)
 *   - `<active>/../<active>`     (traversal that collapses onto the served dir)
 *   - `<active>/`                (trailing slash)
 * The same four names measured through _dirIdentityNearestExisting all read
 * dev 16777230 / ino 1006618890 / residual [] — ONE directory with the served
 * tree — while `some-new-tree`, `gemini-embedding-001` and `_lexical-
 * contextual` read ino 1006618889 with a non-empty residual. That partition is
 * why the existing predicate is reused rather than a second one written: it
 * already separates these exactly, and a second copy of a containment rule is
 * how the bypass it closes came to exist.
 *
 * SAME four-term comparison as isLiveIndexRoot (dev, ino, residual length,
 * residual segments) on the SAME helper. The reference is derived from
 * homedir() for the reason isLiveIndexRoot's doc already states: HOME is the
 * hermetic suite's only root selector, and MEMORY_ROOT is the env-overridable
 * value this predicate exists to VALIDATE — deriving the reference from it
 * would compare a value against itself. As in isLiveIndexRoot, the
 * env-independent CHECKOUT_ROOT is an ADDITIVE second reference (a relocated
 * install serves from <checkout>/indices/<ACTIVE>); it only adds refusals.
 *
 * PURE READS, like the helper it delegates to: it runs before the guard
 * decides to refuse, and a refused run must leave the root it refused
 * byte-identical.
 *
 * FAIL CLOSED: returns TRUE from the catch, i.e. toward refusal. Same
 * asymmetry as isLiveIndexRoot — a false refusal costs one re-pointed rebuild,
 * a false permit clobbers the index a live queryd is serving.
 *
 * @param {string} candidateRoot a MEMORY_ROOT-shaped path
 * @param {string} publishModelVersion the PHYSICAL publish target (i.e. the
 *   output of resolvePublishModelVersion, not the logical name)
 * @returns {boolean} true when `<candidateRoot>/indices/<publishModelVersion>`
 *   is the served index directory, or when that could not be answered
 */
export function isServedIndexTree(candidateRoot, publishModelVersion) {
  try {
    const candidate = _dirIdentityNearestExisting(
      join(candidateRoot, "indices", publishModelVersion),
    );
    const active = CAPS.ACTIVE_EMBED_MODEL_VERSION;
    return _liveRootReferences().some((root) =>
      _sameDirIdentity(candidate, _dirIdentityNearestExisting(join(root, "indices", active))),
    );
  } catch {
    return true;
  }
}

/**
 * Thrown when a rebuild would publish into the LIVE tree (the one a running
 * queryd serves) without being explicitly armed to do so.
 *
 * This THROWS rather than returning a `refused:` envelope on purpose. A soft
 * refusal with wrote_index:false and a success exit is the
 * absence-reported-as-health shape — on a live system nobody reads the
 * envelope, and the operator concludes the rebuild ran.
 */
export class Bm25LiveTreePublishError extends Error {
  constructor(message) {
    super(message);
    this.name = "Bm25LiveTreePublishError";
    this.code = "bm25_live_tree_publish_not_armed";
  }
}

/**
 * r4 — thrown when a rebuild would publish a NON-active target into the live
 * root: a sibling tree beside the served one (`indices/<typo>/`,
 * `indices/_lexical-contextual/`, `indices/<legacy>/`).
 *
 * It does not overwrite the served index, so it is a distinct code from
 * Bm25LiveTreePublishError — but it still writes into the directory the live
 * system reads, and a mistyped --model-version was silently creating a tree
 * there. Same THROW discipline for the same reason: a soft `refused:` envelope
 * with a success exit is the absence-reported-as-health shape.
 */
export class Bm25LiveTreeSiblingPublishError extends Error {
  constructor(message) {
    super(message);
    this.name = "Bm25LiveTreeSiblingPublishError";
    this.code = "bm25_live_tree_sibling_publish_not_armed";
  }
}

// indexPathsFor — mirror of the same helper in index-cache.js, kept local so
// the return envelope's paths need no index-cache call; the rebuild owns its
// own short-lived in-memory index.
function indexPathsFor(modelVersion) {
  const dir = join(MEMORY_ROOT, "indices", modelVersion);
  return {
    dir,
    bm25Path: join(dir, "bm25.json"),
  };
}

// Atomic JSON write: serialize -> write tmp -> fsync -> rename. Mirrors the
// nonce-store.js writeFileAtomic discipline (tmp + fsync + rename) so a
// crash during write leaves either the OLD file intact OR the NEW file
// fully on disk — never a half-written bm25.json that index-cache would
// silently fall back to empty.
function writeJsonAtomic(targetPath, obj) {
  const tmpPath = targetPath + ".tmp";
  // mode 0600 — same as other persisted-state files under MEMORY_ROOT.
  const fd = openSync(tmpPath, "w", 0o600);
  try {
    const json = JSON.stringify(obj);
    writeSync(fd, json);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, targetPath);
}

// writeBm25IndexAtomic — stream a Bm25Index to disk in the v2 NDJSON-section
// format. The v1 single-JSON-object format used by Bm25Index.serialize() +
// saveIndices fails at scale because both JSON.stringify and readFileSync
// hit Node's MAX_STRING_LENGTH cap (~512 MiB / 0x1FFFFFFF8). At ~1.4M facts
// (production scale today) the serialized output crosses that cap and both
// the write path AND the load path throw "Invalid string length".
//
// v2 format (one JSON value per line, header first):
//   {"version":2,"params":{"k1":1.2,"b":0.75},"total_doc_len":N}\n
//   ["P", token, [[doc_id, tf], ...]]\n
//   ["L", doc_id, len]\n
//   ["M", doc_id, meta]\n
//   ["E", ent, [doc_id, ...]]\n
//   ["D", doc_id, [ent, ...]]\n
//
// The leading capital-letter tag is the section discriminator:
//   P = postings entry      (token -> [[doc_id, tf], ...])
//   L = doc_len entry       (doc_id -> token-count)
//   M = doc_meta entry      (doc_id -> {kind, ts})
//   E = entity_index entry  (entity -> [doc_id, ...])
//   D = doc_entities entry  (doc_id -> [entity, ...])
//
// Each line is small (the largest line is one token's posting list); we
// never hold a string larger than one line. Bm25Index.deserialize is
// extended to accept BOTH v1 (legacy in-process build via JSON.parse) AND
// v2 (the on-disk format used by every rebuild script call); index-cache
// detects v2 by reading the first byte and routing to the streaming
// loader (bm25-streaming-loader.js).
export function writeBm25IndexV2Atomic(targetPath, bm25) {
  return writeBm25IndexAtomic(targetPath, bm25);
}

function writeBm25IndexAtomic(targetPath, bm25) {
  const tmpPath = targetPath + ".tmp";
  const fd = openSync(tmpPath, "w", 0o600);
  let bytesWritten = 0;
  function wLine(value) {
    const line = JSON.stringify(value) + "\n";
    const buf = Buffer.from(line, "utf8");
    writeSync(fd, buf);
    bytesWritten += buf.length;
  }
  try {
    // Header — keeps the on-disk format self-describing: a malformed or
    // truncated file is easy to detect (first line MUST be a v2 header).
    wLine({
      version: 2,
      params: { k1: bm25.k1, b: bm25.b },
      total_doc_len: bm25._totalDocLen,
    });
    for (const [token, docs] of bm25._postings) {
      const docsArr = [];
      for (const [docId, tf] of docs) docsArr.push([docId, tf]);
      wLine(["P", token, docsArr]);
    }
    for (const [docId, len] of bm25._docLen) {
      wLine(["L", docId, len]);
    }
    for (const [docId, meta] of bm25._docMeta) {
      wLine(["M", docId, meta]);
    }
    for (const [ent, docSet] of bm25._entityIndex) {
      wLine(["E", ent, Array.from(docSet)]);
    }
    for (const [docId, entSet] of bm25._docEntities) {
      wLine(["D", docId, Array.from(entSet)]);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, targetPath);
  return bytesWritten;
}

/**
 * rebuildBm25IndexFromLedger — stream a JSONL ledger and rebuild the BM25
 * index from every fact row. Writes the resulting blob atomically to
 * indices/<modelVersion>/bm25.json.
 *
 * @param {object} opts
 * @param {string} [opts.ledgerPath]    Absolute path to memory.jsonl.
 *                                       Defaults to memoryLedgerPath().
 * @param {string} [opts.modelVersion]  Index-tree key. Wins over every env
 *   flag. Defaults to CAPS.ACTIVE_EMBED_MODEL_VERSION (l11); the legacy Gemini
 *   key is reachable only via the explicit MEMORY_BM25_REBUILD_TARGET_LEGACY=1
 *   opt-in, and MEMORY_BM25_MODEL_NEUTRAL=1 selects B2's lexical key. See
 *   _defaultRebuildModelVersion() for the full precedence.
 * @param {boolean} [opts.dryRun=false] If true, build the in-memory index
 *                                       but do NOT write to disk.
 * @param {boolean} [opts.contextualPrefix]  WU1 contextual-BM25 toggle. When
 *   true, each fact's content is prefixed with buildContextPrefix(row) +
 *   "\n\n" before tokenization (the prefix is CONCATENATED into the single
 *   tokenized field — see context-prefix.js). Defaults to
 *   CAPS.CONTEXTUAL_BM25_ENABLED. Pass explicitly to build a baseline (false)
 *   vs contextual (true) index pair for the A/B without flipping the global
 *   CAP. Reflected in the return envelope as `contextual_prefix`.
 * @param {boolean} [opts.refuseIfDropsObjectEntities=false] l11 — internal
 *   guard for the daemon seam. When true AND `object_entities_dropped > 0`,
 *   publishGeneration is skipped entirely: `wrote_index` stays false,
 *   `bytes_written` stays 0, the existing index on disk is untouched, and the
 *   envelope carries `refused: "would_drop_object_entities"`. Only
 *   maybeRunBm25Rebuild sets this; every other caller keeps its historical
 *   behaviour byte-for-byte.
 * @param {boolean} [opts.allowLiveTreePublish=false] b1 — arm a publish that
 *   would land in the LIVE tree (isLiveIndexRoot(MEMORY_ROOT)) on the ACTIVE
 *   model. Unarmed, such a publish THROWS Bm25LiveTreePublishError before any
 *   I/O; see the live-tree write guard below. This is FULL arming: it covers
 *   sibling trees as well, which is why the daemon seam needs nothing new.
 *   In-process only — there is no environment variable that sets this, by
 *   design.
 * @param {boolean} [opts.allowLiveTreeSiblingPublish=false] r4 — arm a publish
 *   of a NON-served target into the live tree (a sibling directory beside the
 *   served one). Unarmed, such a publish THROWS
 *   Bm25LiveTreeSiblingPublishError. Also in-process only — an env flag routing
 *   around a write guard is the defect this whole guard exists to close.
 *
 *   WHAT KEEPS IT OFF THE SERVED TREE, mechanism instead of an absolute: the
 *   served-tree refusal is checked first, does not consult this opt, and asks
 *   isServedIndexTree — a dev+ino measurement of the DESTINATION
 *   `MEMORY_ROOT/indices/<publishModelVersion>` — in disjunction with the model
 *   name compare. Until r4-b1-guard-residuals it asked the NAME alone, and this
 *   opt did unlock the served tree: a case-variant, a symlinked model
 *   directory, `<active>/../<active>` and `<active>/` were each measured
 *   publishing over a seeded live bm25.json at exit 0.
 *
 *   NOT COVERED by that measurement, so not claimed: a destination that is not
 *   the served directory but still lands under the live root is exactly what
 *   this opt arms (that is its purpose) — measured, `../storage` under an armed
 *   run wrote `<live>/storage/bm25.json`.
 *
 *   r5 CORRECTION. The sentence that used to close this paragraph — "the whole
 *   check sits inside the isLiveIndexRoot(MEMORY_ROOT) branch, so a root whose
 *   `indices` child is NOT the live one, while a model-version child under it
 *   symlinks into the served directory, never reaches this opt at all" —
 *   described the composition before r5 and is now FALSE. The served-tree
 *   measurement is hoisted OUT of that branch (servedByIdentity at the write
 *   site) and runs on every unarmed non-dry rebuild, so that shape throws
 *   Bm25LiveTreePublishError before this opt is read. MEASURED at this seam:
 *   `MEMORY_ROOT=<other>` with `<other>/indices/<ACTIVE>` symlinked at a seeded
 *   stand-in served directory went from threw=false / wrote_index:true (sentinel
 *   35f8339f… -> df23aa87…, bm25.gen-0.json created) to a throw with code
 *   bm25_live_tree_publish_not_armed and a byte-identical sentinel. The
 *   opt's own reach is unchanged in both directions — its entry condition is
 *   bit-identical across the change. What is still NOT closed is the SIBLING
 *   spelling of that shape; see the guard's carried-limitation list at the
 *   write site, which carries its permit-before / permit-after measurement.
 * @returns {{
 *   ledger_path: string,
 *   model_version: string,
 *   bm25_path: string|null,
 *   contextual_prefix: boolean,
 *   rows_total: number,
 *   rows_indexed: number,
 *   rows_skipped: number,
 *   total_lines: number,
 *   parsed_lines: number,
 *   wrote_index: boolean,
 *   bytes_written: number,
 *   object_entities_dropped: number,
 *   duration_ms: number,
 *   refused?: string
 * }}
 *
 * Defensive: never throws on a malformed ledger line (skipped silently by
 * streamLedgerLines). Throws ONLY on a writer error (mkdir, write, rename)
 * — callers in the daemon should wrap in try/catch and log; the existing
 * bm25.json on disk is left intact because the failed write was to .tmp.
 */
export function rebuildBm25IndexFromLedger(opts = {}) {
  const t0 = Date.now();
  const ledgerPath =
    typeof opts.ledgerPath === "string" && opts.ledgerPath.length > 0
      ? opts.ledgerPath
      : memoryLedgerPath();
  const modelVersion =
    typeof opts.modelVersion === "string" && opts.modelVersion.length > 0
      ? opts.modelVersion
      : _defaultRebuildModelVersion();
  // Where this target PHYSICALLY lands. See resolvePublishModelVersion for why
  // `_lexical` is redirected onto a dense tree; l11 moved that redirect's
  // destination to the ACTIVE model and the redirect itself must stay.
  const publishModelVersion = resolvePublishModelVersion(modelVersion);
  const dryRun = opts.dryRun === true;

  // --- LIVE-TREE WRITE GUARD (before ANY build, so nothing is even read) ----
  // A full rebuild of the tree a running queryd serves is an operator action
  // against a temp root, never a side effect of naming a target. The test is
  // on the PHYSICAL publish target, not the logical one: `_lexical` names a
  // projection but lands in the ACTIVE model's tree, and the CLI's guard —
  // which compared the LOGICAL name — let exactly that through.
  //
  // Arming is an IN-PROCESS option only. There is deliberately no environment
  // variable here: the defect this closes was an env flag
  // (MEMORY_BM25_MODEL_NEUTRAL, a recall-side READ selector consumed by
  // resolveBm25Member) routing around a write guard, so a new env flag would
  // just be a new bypass. Naming a target is not authorization to write one.
  //
  // r4 — the root test is isLiveIndexRoot(), which measures DIRECTORY IDENTITY
  // (dev+ino, via statSync, which follows symlinks) on BOTH sides for the
  // `indices` directory that actually gets written. The MECHANISM, stated
  // instead of an absolute: any number of path strings that name one directory
  // compare equal by construction, whatever produced the extra spelling —
  // symlink, case-insensitive volume, firmlink, bind-style alias. A string
  // compare on realpath output did not have that property: on this host
  // <HOME>/MEMORY-SYSTEM and /System/Volumes/Data<HOME>/memory-system
  // both realpath to themselves and were measured to walk straight past the
  // guard (both seams, exit 0, live bm25.json clobbered).
  // What genuinely REMAINS uncovered, named rather than implied:
  //   - a MEMORY_ROOT pointing INSIDE the live root (e.g. <live>/scratch): its
  //     indices/ is a different directory, so this is permitted by design, but
  //     it does write under the sacred root;
  //   - a symlinked `storage/` child: only `indices` is measured here,
  //     because only indices/ is what a rebuild publishes;
  //   - the not-yet-existing tail below the nearest existing ancestor is
  //     compared as STRINGS, so two sibling paths differing only in case would
  //     compare unequal even though creating either would produce the same
  //     directory on a case-insensitive volume. MEASURED BOUND on how far that
  //     reaches, both halves: a name that ALIASES AN EXISTING directory stats
  //     successfully and yields an empty residual (`QWEN3-EMBEDDING-8B-FP16`,
  //     `<active>-alias`, `<active>/`, `<active>/../<active>` all measured
  //     dev 16777230 / ino 1006618890 / residual [] — the served directory's
  //     own identity), while a name that ENOENTs walks up and carries a
  //     non-empty residual (`some-new-tree` -> ino 1006618889 / residual
  //     ["some-new-tree"]). So the string-tail path is reachable only when the
  //     destination resolves to NOTHING — i.e. when there is no served index
  //     there to clobber;
  //   - an in-process caller that constructs a live MEMORY_ROOT and passes
  //     allowLiveTreePublish deliberately — that is the arming path, not a gap.
  //
  // r4-b1-guard-residuals — the served-tree question is now a DISJUNCTION of
  // the model-name compare and isServedIndexTree, which measures the
  // DESTINATION `MEMORY_ROOT/indices/<publishModelVersion>` (index-cache.js's
  // indicesDir() + indexPathsFor() is what publishGeneration writes). Name
  // aliasing is the same defect class one level down: the name compare alone
  // was measured routing a case-variant, a symlinked model directory,
  // `<active>/../<active>` and `<active>/` into the SIBLING arm, where the
  // sibling opt then published each of them over a seeded live bm25.json
  // (exit 0, sha256 35f8339f… -> 54e3c1bb…, bm25.gen-0.json created), at both
  // the CLI and library seams.
  // WHAT THAT ADDITION STILL DOES NOT COVER, named rather than implied:
  //   - CAPS.ACTIVE_EMBED_MODEL_VERSION is a PROXY for what queryd actually
  //     serves, not a measurement of it. Nothing here reads the running
  //     daemon's loaded model; if queryd were serving a different tree than
  //     the CAP names, this guard would protect the wrong directory;
  //   - the guard is a PURE READ taken strictly BEFORE the write, so the
  //     window between the measurement and publishGeneration is uncovered: a
  //     rename or symlink swap landing in that window redirects the write the
  //     guard already approved (TOCTOU). Closing it needs an fd held across
  //     the publish, which is not what this guard is;
  //   - a publishModelVersion containing traversal that lands OUTSIDE
  //     indices/ (`../storage`) is measured as NOT the served directory, so it
  //     falls to the SIBLING arm — refused by default, but still writable
  //     under the live root once that arm is armed;
  //
  // r5 — CLOSED, NOT CARRIED. The bullet that stood here said "a root that is
  // NOT the live root but whose model-version child is a symlink INTO the
  // served directory still publishes … Closing this means gating the block on
  // the destination rather than on the root, which is a wider change than this
  // guard makes." That is exactly the change r5 made: the destination
  // measurement is hoisted above this block (see servedByIdentity), so the
  // identity answer is no longer subordinated to a proxy for it. RE-MEASURED at
  // both seams on a stand-in live root under TMP, with the precondition pair
  // isServedIndexTree(<other>,<ACTIVE>)===true / isLiveIndexRoot(<other>)===false
  // recorded on the same run:
  //     BEFORE  CLI exit 0, empty stderr, sentinel 35f8339f… -> df23aa87…,
  //             bm25.gen-0.json created; LIBRARY threw=false, wrote_index:true,
  //             same clobber.
  //     AFTER   CLI exit 2, stderr matching /refusing to publish/, stdout
  //             empty; LIBRARY throws code bm25_live_tree_publish_not_armed;
  //             sentinel byte-identical, no bm25.gen-0.json, at both seams.
  //
  // r5 RESIDUAL, MEASURED AND NOT CLOSED — the SIBLING spelling of the shape
  // above: a non-live root whose NON-served model-version child symlinks under
  // the live root, e.g. `<other>/indices/<ACTIVE>-typo` ->
  // `<live>/indices/<ACTIVE>-typo`. isServedIndexTree measures the SERVED
  // directory only, so it reports false there, and isLiveIndexRoot(<other>) is
  // false, so nothing refuses. MEASURED on the same harness, verdict PERMIT
  // BEFORE and PERMIT AFTER (exit 0; the sibling bm25.json went 35f8339f… ->
  // df23aa87… with a bm25.gen-0.json beside it, while the SERVED sentinel
  // stayed byte-identical at 35f8339f…) — so it is not a monotonicity
  // violation, it is coverage this guard does not have. Closing it needs an
  // "is the destination anywhere under the live root" predicate, i.e. a THIRD
  // containment rule; two copies of a containment rule is how the original
  // bypass came to exist, so it is filed rather than fixed here.
  //
  // r4 — the guard now covers the whole live root, not only the served tree.
  // Publishing a SIBLING tree (a mistyped --model-version, `_lexical-
  // contextual`, the legacy model) does not clobber the served index, but it
  // does create a directory the live system reads, so it is refused too — with
  // its own code, and armed by its own in-process opt. allowLiveTreePublish
  // still covers everything, which is why the daemon seam is untouched.
  // r5 — THE DESTINATION MEASUREMENT, HOISTED OUT OF THE ROOT PROXY.
  // Until r5 the whole disjunction lived inside the isLiveIndexRoot(MEMORY_ROOT)
  // block below, so the identity answer was gated on the ROOT being live. That
  // made a correct predicate inert exactly where it was supposed to add value:
  // MEASURED at this seam, `MEMORY_ROOT=<other>` (a temp root, isLiveIndexRoot
  // false) with `<other>/indices/<ACTIVE>` symlinked at a seeded stand-in served
  // directory returned threw=false / wrote_index:true and rewrote the sentinel
  // (sha256 35f8339f… -> df23aa87…, bm25.gen-0.json created) on the same run
  // that reported isServedIndexTree(<other>,<ACTIVE>)===true. The question the
  // guard exists to answer is WHERE THE WRITE LANDS, so it is answered here,
  // unconditionally, on every unarmed non-dry rebuild.
  //
  // COST, stated honestly because the comment it replaces claimed the opposite
  // ("Evaluated HERE ... so a non-live caller pays no extra stat"): every
  // unarmed non-dry rebuild — including every contained rebuild and every test
  // root — now pays isServedIndexTree, i.e. two _dirIdentityNearestExisting
  // ancestor walks (the candidate destination and the served reference), each a
  // statSync loop up to the nearest existing directory. It is paid because the
  // cheaper composition was measured permitting a clobber of the served index.
  // The registered false-positive controls that this cost buys nothing against
  // are still green: "r4 — canonicalization does not start refusing legitimate
  // temp roots" and "r4-b1 — a temp root sharing an ancestor with the live root
  // still publishes".
  //
  // `opts.allowLiveTreePublish !== true` is a PRECONDITION of the measurement,
  // not an afterthought: maybeRunBm25Rebuild (the daemons/watermark.js seam)
  // passes it and must stay FULLY armed, so an armed caller never even measures.
  // FAIL CLOSED is inherited unchanged — isServedIndexTree returns TRUE from its
  // catch, so an unmeasurable destination refuses rather than publishes.
  const servedByIdentity =
    !dryRun && opts.allowLiveTreePublish !== true
      ? isServedIndexTree(MEMORY_ROOT, publishModelVersion)
      : false;

  // ONE served-tree refusal message, built once for the two throw sites rather
  // than duplicated. `liveRoot` selects the REMEDY, and it has to: telling an
  // operator to "point MEMORY_ROOT at a temp directory" is false advice on the
  // branch r5 newly made reachable, where MEMORY_ROOT ALREADY is a temp root and
  // the thing that names the served directory is its indices/<model-version>
  // child. The live-root wording is unchanged byte-for-byte, so every message
  // assertion registered against the previously-reachable cases still holds.
  const servedRefusalMessage = (liveRoot) =>
    `refusing to publish model_version=${modelVersion}` +
    (modelVersion === publishModelVersion
      ? ""
      : ` (publishes into ${publishModelVersion})`) +
    (liveRoot
      ? (publishModelVersion === CAPS.ACTIVE_EMBED_MODEL_VERSION
          ? `, the ACTIVE embedding model, into the live tree at `
          : `, whose directory IS the served ` +
            `${CAPS.ACTIVE_EMBED_MODEL_VERSION} tree, into the live tree at `) +
        `${resolve(MEMORY_ROOT)}. A full rebuild of the tree queryd serves is ` +
        "an operator action against a temp root. Point MEMORY_ROOT at a temp " +
        "directory, pass dryRun, or pass allowLiveTreePublish:true if you are " +
        "the armed periodic writer."
      : `: ${join(resolve(MEMORY_ROOT), "indices", publishModelVersion)} IS the ` +
        `served ${CAPS.ACTIVE_EMBED_MODEL_VERSION} index directory by directory ` +
        `identity, while ${resolve(MEMORY_ROOT)} is NOT the live root. ` +
        "Re-pointing MEMORY_ROOT is therefore not the fix — the aliasing " +
        "indices/<model-version> child under the root you already passed is. " +
        "Repoint or remove that child, pass dryRun, or pass " +
        "allowLiveTreePublish:true if you are the armed periodic writer.");

  // The hoisted refusal, BEFORE the root-gated block. isLiveIndexRoot is called
  // here only on the refusal path — the process is throwing anyway — so the
  // tailored remedy costs nothing on any run that publishes.
  if (servedByIdentity) {
    throw new Bm25LiveTreePublishError(
      servedRefusalMessage(isLiveIndexRoot(MEMORY_ROOT)),
    );
  }

  if (!dryRun && opts.allowLiveTreePublish !== true && isLiveIndexRoot(MEMORY_ROOT)) {
    // r4-b1-guard-residuals — "is this the SERVED tree?" is a DISJUNCTION, and
    // the name term stays. It is load-bearing, not belt-and-braces:
    // isLiveIndexRoot can return true out of its fail-closed catch while the
    // destination measurement above succeeds and reports "not the served tree",
    // and a bare replacement would then wave `--allow-live-tree=<ACTIVE>`
    // through — a LOOSENING that breaks the registered case "r4 —
    // --allow-live-tree=<ACTIVE> does NOT reopen the served tree". Adding a
    // disjunct can only turn permits into refusals, never the reverse.
    // r5 — the identity disjunct is REUSED from the hoisted measurement rather
    // than recomputed (one stat pass, one definition). Reaching this line means
    // servedByIdentity was false, so the NAME term is what can still fire here;
    // the disjunction is kept whole because it, not the message, is what keeps
    // the acknowledgement flag off the served tree when isLiveIndexRoot fails
    // closed.
    const targetsServed =
      publishModelVersion === CAPS.ACTIVE_EMBED_MODEL_VERSION || servedByIdentity;
    if (targetsServed) {
      throw new Bm25LiveTreePublishError(servedRefusalMessage(true));
    }
    if (opts.allowLiveTreeSiblingPublish !== true) {
      throw new Bm25LiveTreeSiblingPublishError(
        `refusing to publish model_version=${modelVersion}` +
          (modelVersion === publishModelVersion
            ? ""
            : ` (publishes into ${publishModelVersion})`) +
          ` into the live tree at ${resolve(MEMORY_ROOT)}. It is not the ACTIVE ` +
          "embedding model, so it would create a SIBLING index tree beside the " +
          "one queryd serves — which is what a mistyped --model-version looks " +
          "like. Point MEMORY_ROOT at a temp directory, pass dryRun, or pass " +
          "allowLiveTreeSiblingPublish:true if the sibling tree is deliberate.",
      );
    }
  }
  // The production ledger overwhelmingly carries object-shaped entities, but
  // accepting those here changes serialized output. Keep the historical
  // string-only projection byte-for-byte unless its own exact opt-in is set.
  const includeObjectEntities =
    process.env[BM25_REBUILD_OBJECT_ENTITIES_FLAG] === "1";
  // WU1 — contextual-BM25 toggle. Explicit opt wins (for hermetic A/B builds);
  // otherwise fall back to the CAPS kill-switch (default false).
  const contextualPrefix =
    typeof opts.contextualPrefix === "boolean"
      ? opts.contextualPrefix
      : CAPS.CONTEXTUAL_BM25_ENABLED === true;

  // WU-backward-conversation-index — when building the contextual index, load
  // the derived conversation index ONCE so each fact's prefix can resolve a
  // real thread label. We do a SYNCHRONOUS, CACHE-ONLY read (this function is
  // sync — every caller treats its result as a plain value): the index is
  // built out-of-band by scripts/build-conversation-index.mjs and consumed
  // here. Best-effort + defensive: a missing / stale / corrupt cache leaves
  // conversationIndex=null and the prefix degrades to the on-row resolution
  // (the historical behavior). Opt override:
  //   - opts.conversationIndex === false  -> disable the join (hermetic A/B).
  //   - opts.conversationIndex (object)   -> caller-supplied index (tests).
  let conversationIndex = null;
  if (contextualPrefix && opts.conversationIndex !== false) {
    if (opts.conversationIndex && typeof opts.conversationIndex === "object") {
      conversationIndex = opts.conversationIndex;
    } else {
      try {
        conversationIndex = loadConversationIndexFromCacheSync({
          ledgerPath,
          cachePath: join(STORAGE_DIR, "conversation-index.cache.json"),
        });
      } catch {
        conversationIndex = null;
      }
    }
  }

  const { dir, bm25Path: sourceBm25Path } = indexPathsFor(publishModelVersion);
  // A neutral projection has no fixed bm25.json. Before publication there is
  // no authoritative generation filename to report, so dry-run returns null
  // instead of advertising a path that can never exist.
  let authoritativeBm25Path =
    modelVersion === LEXICAL_INDEX_KEY ? null : sourceBm25Path;
  const idx = new Bm25Index();
  let rowsTotal = 0;
  let rowsIndexed = 0;
  let rowsSkipped = 0;
  // l11 — OBSERVATIONAL counter (see the entity loop below). Counts entities
  // that WOULD have been indexed under includeObjectEntities but are dropped
  // because the flag is off. Reported on every return path so a caller can see
  // an entity-less projection coming instead of discovering it after publish;
  // `opts.refuseIfDropsObjectEntities` turns it into a refusal.
  let objectEntitiesDropped = 0;

  // streamLedgerLines silently skips malformed JSON lines. We additionally
  // skip rows that lack the BM25-required fields (id, content). A row may
  // legitimately have empty content (e.g. some non-fact ledger rows) — we
  // count those in rows_skipped but do NOT treat as errors.
  const counts = streamLedgerLines(ledgerPath, (row) => {
    rowsTotal += 1;
    if (row == null || typeof row !== "object") {
      rowsSkipped += 1;
      return;
    }
    const id = row.id;
    if (typeof id !== "string" || id.length === 0) {
      rowsSkipped += 1;
      return;
    }
    const content = row.content;
    if (typeof content !== "string" || content.length === 0) {
      rowsSkipped += 1;
      return;
    }
    // Default-off parity is deliberately the historical string-only shape.
    // The independent object-entity flag opts into matching rowToIndexEntry's
    // production {canonical_id} shape without silently changing legacy output.
    const features = row.features && typeof row.features === "object"
      ? row.features
      : {};
    const entitiesRaw = Array.isArray(features.entities) ? features.entities : [];
    const entities = [];
    for (const e of entitiesRaw) {
      // Same predicate as the historical accept branch, hoisted so the drop
      // case can be COUNTED without changing which ids reach `entities`.
      const objectCanonical =
        e && typeof e === "object" && typeof e.canonical_id === "string"
          ? e.canonical_id.toLowerCase()
          : null;
      if (includeObjectEntities && objectCanonical !== null) {
        if (objectCanonical.length > 0) entities.push(objectCanonical);
      } else if (typeof e === "string" && e.length > 0) {
        entities.push(e.toLowerCase());
      } else if (objectCanonical !== null && objectCanonical.length > 0) {
        // Flag off + a production-shaped entity: it is silently dropped, which
        // is exactly how a rebuild can publish an index with no entities at
        // all. Count it; the caller decides whether that is acceptable.
        objectEntitiesDropped += 1;
      }
    }
    // WU1 contextual BM25 — concatenate a deterministic context prefix onto the
    // tokenized content. buildContextPrefix is pure + never throws; an empty
    // prefix (nothing resolved) degrades to the raw content (a no-op, so the
    // contextual index is never WORSE than the baseline on a prefix-less row).
    // We deliberately concatenate into the SINGLE content field (not a second
    // BM25 field): our score is additive over query terms, so prefix + content
    // matches sum — strictly more recall than the cookbook's two-field MAX.
    let indexedContent = content;
    if (contextualPrefix) {
      let prefix = "";
      try {
        // WU-backward-conversation-index — thread the conversation index in so
        // historical facts (provenance.conversation_id === null) resolve a real
        // thread label. conversationIndex===null -> buildContextPrefix ignores
        // opts and uses the on-row resolution (current behavior).
        prefix =
          conversationIndex !== null
            ? buildContextPrefix(row, { conversationIndex, lookupConversation })
            : buildContextPrefix(row);
      } catch {
        prefix = "";
      }
      if (typeof prefix === "string" && prefix.length > 0) {
        indexedContent = prefix + "\n\n" + content;
      }
    }
    try {
      idx.add({
        memory_id: id,
        kind: typeof row.kind === "string" ? row.kind : "fact",
        content: indexedContent,
        ts: typeof row.created_at === "string" ? row.created_at : "",
        entities,
      });
      rowsIndexed += 1;
    } catch {
      // Bm25Index.add only throws on shape errors we already guarded above;
      // belt-and-braces — count as skipped rather than crashing the rebuild.
      rowsSkipped += 1;
    }
  });

  let bytesWritten = 0;
  let wroteIndex = false;
  // l11 — ENTITY-DROP REFUSAL (opt-in; only maybeRunBm25Rebuild sets it, so
  // direct library and CLI callers are byte-unchanged). Publishing a string-
  // only projection over a tree whose ledger carries object-shaped entities
  // replaces a served index with one that answers no entity query at all.
  // When the caller asks to be protected and the counter is non-zero we skip
  // publishGeneration entirely: nothing is written and the OLD index stays.
  const refused = opts.refuseIfDropsObjectEntities === true &&
    objectEntitiesDropped > 0;
  if (!dryRun && !refused) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    // Streaming write — critical at production scale. JSON.stringify on the
    // full Bm25Index.serialize() blob exceeds Node's MAX_STRING_LENGTH cap
    // (~512 MiB) at ~1.4M facts, so we incrementally encode each section
    // (postings / doc_len / etc.) without ever holding the whole JSON
    // string in memory. The output is byte-identical to what
    // JSON.stringify(idx.serialize()) would produce, modulo property
    // ordering (the streaming writer fixes the order: version, params,
    // postings, doc_len, doc_meta, total_doc_len, entity_index,
    // doc_entities — same as serialize()).
    //
    // S3 FIX CYCLE 2 — the SAME writeBm25IndexAtomic tmp+rename lands the
    // byte-identical v2 output at the fixed path, but the publication is now
    // bracketed by the generation-manifest protocol via publishGeneration
    // (retain outgoing → write → re-checksum bm25, carry the untouched hnsw
    // member's recorded checksum forward → single-rename manifest activation
    // → GC). Pre-fix, the daemon's rebuild rewrote bm25.json with NO
    // manifest rebind, so the next cold load REFUSED the whole generation
    // (checksum mismatch) — on a previous-less tree recall served EMPTY
    // indices until the next saveIndices, and the rebuild output was
    // silently discarded.
    publishGeneration(publishModelVersion, {
      bm25: (fixedPath) => {
        bytesWritten = writeBm25IndexAtomic(fixedPath, idx);
      },
    });
    if (modelVersion === LEXICAL_INDEX_KEY) {
      const projection = activateBm25Projection({
        sourceModelVersion: publishModelVersion,
        ledgerPath,
      });
      authoritativeBm25Path = projection.bm25Path;
    }
    wroteIndex = true;
  }

  const envelope = {
    ledger_path: ledgerPath,
    model_version: modelVersion,
    bm25_path: authoritativeBm25Path,
    contextual_prefix: contextualPrefix,
    rows_total: rowsTotal,
    rows_indexed: rowsIndexed,
    rows_skipped: rowsSkipped,
    total_lines: counts.totalLines,
    parsed_lines: counts.parsedLines,
    wrote_index: wroteIndex,
    bytes_written: bytesWritten,
    object_entities_dropped: objectEntitiesDropped,
    duration_ms: Date.now() - t0,
  };
  if (refused) envelope.refused = "would_drop_object_entities";
  return envelope;
}

// ---------------------------------------------------------------------------
// Daemon trigger discipline (WU-RR1 §B).
//
// State file: storage/bm25-rebuild-state.json. Records
//   { last_rebuild_ts, last_rebuild_ledger_size, last_rebuild_fact_count,
//     last_rebuild_model_version }
// after every successful rebuild. The daemon's idle-tick check reads this
// to decide whether to trigger a new rebuild.
//
// Trigger predicate (on each idle tick, gated by the daemon's own cadence
// counter — we do NOT want to stat the ledger on every 15s tick):
//   1. If state file missing → first-run; rebuild immediately.
//   2. If ledger.size <= last_rebuild_ledger_size → no growth; skip.
//   3. If ledger.size grew → count facts via countFactRowsCheckpointed:
//      an S1-checkpoint delta count (storage/bm25-growth-check.json
//      sidecar) that reads ONLY the appended rows since the last check —
//      O(witness + delta) instead of the historical full-ledger stream
//      (~2.18GB/several seconds per check). A full recount happens only
//      when the sidecar is missing/invalid or the checkpoint's prefix-
//      identity witness fails (rewrite/rotation/shrink).
//   4. If (current_fact_count - last_rebuild_fact_count) >=
//      CAPS.BM25_REBUILD_THRESHOLD → rebuild + persist new state.
//
// Defensive: rebuild failure → log + leave the OLD bm25.json + state file
// intact. We do NOT overwrite the state on failure, so the next tick
// retries against the same delta (eventually-consistent recovery).
// ---------------------------------------------------------------------------

function statePath() {
  return join(STORAGE_DIR, "bm25-rebuild-state.json");
}

function ledgerSize(ledgerPath) {
  try {
    return statSync(ledgerPath).size;
  } catch {
    return 0;
  }
}

/**
 * readRebuildState — read the persisted rebuild-state file. Returns null if
 * the file is missing, malformed, or a read error occurred (treated as
 * first-run; the trigger will then rebuild unconditionally).
 */
export function readRebuildState() {
  const path = statePath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const obj = JSON.parse(raw);
    if (obj == null || typeof obj !== "object") return null;
    return obj;
  } catch {
    return null;
  }
}

function writeRebuildState(state) {
  const path = statePath();
  if (!existsSync(STORAGE_DIR)) {
    mkdirSync(STORAGE_DIR, { recursive: true, mode: 0o700 });
  }
  writeJsonAtomic(path, state);
}

/**
 * countFactRowsStreamed — stream-count rows on the ledger that are eligible
 * for BM25 indexing (string id + string content). Bounded memory; the cost
 * scales with file size, NOT the parsed-row size.
 *
 * @param {string} ledgerPath
 * @returns {{ ledger_size: number, fact_count: number, total_lines: number }}
 */
export function countFactRowsStreamed(ledgerPath) {
  const size = ledgerSize(ledgerPath);
  let factCount = 0;
  const counts = streamLedgerLines(ledgerPath, (row) => {
    if (row == null || typeof row !== "object") return;
    if (typeof row.id !== "string" || row.id.length === 0) return;
    if (typeof row.content !== "string" || row.content.length === 0) return;
    factCount += 1;
  });
  return {
    ledger_size: size,
    fact_count: factCount,
    total_lines: counts.totalLines,
  };
}

// ---------------------------------------------------------------------------
// W2 (memperf) — O(delta) growth check.
//
// countFactRowsCheckpointed replaces countFactRowsStreamed at the daemon
// trigger's call site. It persists a {checkpoint, fact_count} sidecar at
// storage/bm25-growth-check.json and, on each check, counts ONLY the rows
// appended since the sidecar's S1 checkpoint (ledger-checkpoint.js). A full
// recount happens ONLY when the sidecar is missing/invalid or the
// checkpoint's prefix-identity witness fails (rewrite/rotation/shrink) —
// surfaced in `full_reason`. countFactRowsStreamed stays exported and
// untouched: it is the equivalence oracle for
// test/daemons/bm25-growth-check.test.mjs.
//
// EQUIVALENCE CONTRACT (proven by that suite): for any ledger state,
// countFactRowsCheckpointed(...).fact_count === countFactRowsStreamed(...)
// .fact_count. Two subtleties make that hold:
//   - Same eligibility predicate (non-null object, non-empty string id,
//     non-empty string content) applied per parsed line; same 8MiB
//     oversized-line skip (both streamers share it).
//   - Torn-tail parity: streamLedgerLines parses an unterminated trailing
//     line at EOF (_ledger-stream.js:227-238) while readAppended never
//     delivers torn lines. We read the torn tail [eof, size) directly and
//     add its (0|1) contribution to the RETURNED count only — the PERSISTED
//     sidecar.fact_count covers exactly [0, checkpoint.eof), so a completed
//     tail is counted exactly once on the next check.
// ---------------------------------------------------------------------------

// Torn-tail read cap — mirrors both streamers' 8MiB oversized-line skip.
const GROWTH_CHECK_TAIL_MAX_BYTES = 8 * 1024 * 1024;

function growthCheckSidecarPath() {
  return join(STORAGE_DIR, "bm25-growth-check.json");
}

// readGrowthCheckSidecar — defensive read mirroring readRebuildState's
// discipline. Returns { fact_count, checkpoint } or null when the sidecar is
// missing, malformed JSON, wrong version, pinned to a different ledger path,
// carries a non-finite/negative count, or its checkpoint fails strict
// deserialization. Never throws.
function readGrowthCheckSidecar(ledgerPath) {
  const path = growthCheckSidecarPath();
  if (!existsSync(path)) return null;
  let obj;
  try {
    obj = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (obj == null || typeof obj !== "object") return null;
  if (obj.v !== 1) return null;
  if (obj.ledger_path !== ledgerPath) return null;
  if (
    typeof obj.fact_count !== "number" ||
    !Number.isFinite(obj.fact_count) ||
    obj.fact_count < 0
  ) {
    return null;
  }
  const checkpoint = deserializeCheckpoint(obj.checkpoint);
  if (checkpoint === null) return null;
  return { fact_count: obj.fact_count, checkpoint };
}

// isBm25EligibleRow — EXACTLY countFactRowsStreamed's predicate. Any change
// here breaks the equivalence contract above; change both or neither.
function isBm25EligibleRow(row) {
  if (row == null || typeof row !== "object") return false;
  if (typeof row.id !== "string" || row.id.length === 0) return false;
  if (typeof row.content !== "string" || row.content.length === 0) return false;
  return true;
}

// countTornTail — (0|1) contribution of the torn (unterminated) tail bytes
// [eof, size), matching streamLedgerLines' EOF flush: parse as JSON, apply
// the eligibility predicate, skip silently on parse failure. Never throws.
function countTornTail(ledgerPath, cp) {
  const len = cp.size - cp.eof;
  if (len <= 0 || len > GROWTH_CHECK_TAIL_MAX_BYTES) return 0;
  let fd = -1;
  try {
    fd = openSync(ledgerPath, "r");
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, cp.eof + got);
      if (n === 0) break; // file changed under us; count what we can't parse as 0
      got += n;
    }
    if (got !== len) return 0;
    const row = JSON.parse(buf.toString("utf8"));
    return isBm25EligibleRow(row) ? 1 : 0;
  } catch {
    // open/read failure or invalid JSON — same outcome as the oracle's
    // silent torn-line skip.
    return 0;
  } finally {
    if (fd !== -1) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * countFactRowsCheckpointed — O(witness + appended delta + torn tail) fact
 * count, equivalent to countFactRowsStreamed (see contract above) without
 * streaming the whole ledger on the warm path.
 *
 * @param {string} ledgerPath
 * @returns {{
 *   ledger_size: number,
 *   fact_count: number,
 *   mode: "incremental" | "full" | "unavailable",
 *   full_reason: string | null,
 *   appended_lines: number,
 *   appended_bytes: number
 * }}
 *   mode "incremental"  — sidecar prefix verified; only the delta was read.
 *   mode "full"         — full recount; `full_reason` says why (exact
 *                          strings: "no-sidecar", "delta-error", or a
 *                          verifyPrefix reason such as "shrunk" /
 *                          "prefix-drift" / "io-error").
 *   mode "unavailable"  — no certified count exists; zeros, sidecar
 *                          untouched. full_reason is null when the ledger
 *                          is missing/unreadable (parity with
 *                          countFactRowsStreamed's missing-file zeros), or
 *                          "full-recount-error:<readAppended error>" when
 *                          the FULL recount itself failed mid-read (W2b
 *                          fail-closed: a partial count is never reported
 *                          as truth; the next check re-decides from real
 *                          on-disk state, matching the old transient
 *                          one-bad-check behavior).
 *
 * Persists the advanced sidecar via writeJsonAtomic ONLY when the count
 * certified complete coverage of [0, newCp.eof) (fail-closed — an
 * uncertified partial count under a valid checkpoint would poison every
 * subsequent incremental count); persistence failure is non-fatal (the next
 * check falls back to a full recount). Never throws.
 */
export function countFactRowsCheckpointed(ledgerPath) {
  const sidecar = readGrowthCheckSidecar(ledgerPath);
  const newCp = captureCheckpoint(ledgerPath, {
    prev: sidecar === null ? undefined : sidecar.checkpoint,
  });
  if (newCp === null) {
    return {
      ledger_size: 0,
      fact_count: 0,
      mode: "unavailable",
      full_reason: null,
      appended_lines: 0,
      appended_bytes: 0,
    };
  }

  let mode = "full";
  let fullReason = "no-sidecar";
  let prefixCount = 0;
  let appendedLines = 0;
  let appendedBytes = 0;

  // Incremental path — requires a valid sidecar whose checkpoint is still a
  // byte-identical prefix of the ledger (O(witness) verification, never a
  // full-prefix read) and whose eof has not regressed.
  if (sidecar !== null) {
    const pv = verifyPrefix(ledgerPath, sidecar.checkpoint);
    if (!pv.ok) {
      fullReason = pv.reason;
    } else {
      // NO eof-regression guard is needed here (W2b, proof): every valid
      // checkpoint's witness includes an entry ending exactly at eof
      // (sampleBlockIndices always samples the final block;
      // isValidCheckpoint rejects checkpoints without it), so pv.ok proves
      // byte sidecar.checkpoint.eof - 1 is still the terminating "\n" and
      // size >= sidecar.checkpoint.eof — hence findNewlineSafeEof yields
      // newCp.eof >= sidecar.checkpoint.eof on the same bytes. The ONLY
      // window is a concurrent rewrite between captureCheckpoint (above)
      // and this verifyPrefix; that race stays fail-closed without a
      // dedicated branch because readAppended rejects from.eof > to.eof
      // with error "from-after-to" (before any I/O), landing in the
      // "delta-error" full recount below — the same action a dedicated
      // guard would take.
      let counted = 0;
      const res = readAppended(
        ledgerPath,
        sidecar.checkpoint,
        newCp,
        (text) => {
          let row;
          try {
            row = JSON.parse(text);
          } catch {
            return; // malformed line — oracle's streamer skips it too
          }
          if (isBm25EligibleRow(row)) counted += 1;
        },
      );
      if (res.error === null) {
        mode = "incremental";
        fullReason = null;
        prefixCount = sidecar.fact_count + counted;
        appendedLines = res.lines;
        appendedBytes = res.bytes;
      } else {
        fullReason = "delta-error";
      }
    }
  }

  // Full path — same streamer (readAppended from the origin cursor), same
  // parse/skip semantics, so both paths share one predicate and one 8MiB
  // oversized-line rule.
  if (mode === "full") {
    let counted = 0;
    const res = readAppended(ledgerPath, emptyCheckpoint(), newCp, (text) => {
      let row;
      try {
        row = JSON.parse(text);
      } catch {
        return;
      }
      if (isBm25EligibleRow(row)) counted += 1;
    });
    if (res.error !== null) {
      // Fail closed (W2b): the full recount did not certify complete
      // coverage of [0, newCp.eof) — `counted` is PARTIAL. Persisting it
      // under the (valid) newCp checkpoint would poison every subsequent
      // incremental count, so skip the persist entirely (any existing
      // sidecar is left untouched; the next check re-decides from real
      // on-disk state) and report "unavailable" with zeros. Zeros keep
      // maybeRunBm25Rebuild safest: with rebuild state present the delta
      // goes negative → skipped_below_threshold (skip this tick, retry
      // next — the old transient one-bad-check behavior); a partial count
      // could instead spuriously trigger or suppress a rebuild.
      return {
        ledger_size: 0,
        fact_count: 0,
        mode: "unavailable",
        full_reason: `full-recount-error:${res.error}`,
        appended_lines: 0,
        appended_bytes: 0,
      };
    }
    prefixCount = counted;
    appendedLines = res.lines;
    appendedBytes = res.bytes;
  }

  // Persist the advanced sidecar. fact_count covers EXACTLY [0, newCp.eof)
  // — the torn tail below is never persisted. Non-fatal on failure.
  try {
    const serialized = serializeCheckpoint(newCp);
    if (serialized !== null) {
      if (!existsSync(STORAGE_DIR)) {
        mkdirSync(STORAGE_DIR, { recursive: true, mode: 0o700 });
      }
      writeJsonAtomic(growthCheckSidecarPath(), {
        v: 1,
        ledger_path: ledgerPath,
        checkpoint: serialized,
        fact_count: prefixCount,
        updated_at: new Date().toISOString(),
      });
    }
  } catch {
    // non-fatal — the next check falls back per readGrowthCheckSidecar
  }

  // Torn-tail parity (returned value ONLY — see contract above).
  const tornExtra = newCp.size > newCp.eof ? countTornTail(ledgerPath, newCp) : 0;

  return {
    ledger_size: newCp.size,
    fact_count: prefixCount + tornExtra,
    mode,
    full_reason: fullReason,
    appended_lines: appendedLines,
    appended_bytes: appendedBytes,
  };
}

/**
 * maybeRunBm25Rebuild — daemon-side trigger. Decides whether a rebuild is
 * due based on CAPS.BM25_REBUILD_THRESHOLD and runs it if so. Fully
 * defensive: never throws; returns an envelope describing the action taken.
 *
 * l11 added two refusals at this seam, both INTENTIONAL status changes from
 * paths that previously reported success:
 *   - UNARMED -> action "disabled", reason "no_explicit_rebuild_target". With
 *     no opts.modelVersion and none of the exact-"1" target flags set, this
 *     returns before any I/O. The argument-less daemon call no longer performs
 *     an automatic full rebuild of any tree; an operator arms it explicitly.
 *   - WOULD DROP ENTITIES -> action "rebuild_failed", error
 *     "would_drop_object_entities". Nothing is written and the state file is
 *     not advanced. See the refusal comment below.
 *
 * @param {object} opts
 * @param {string} [opts.ledgerPath]
 * @param {string} [opts.modelVersion]  Also ARMS the trigger — see the gate.
 * @param {number} [opts.threshold]  Override CAPS.BM25_REBUILD_THRESHOLD
 *                                    (mainly for hermetic tests).
 * @returns {{
 *   action: "skipped_no_growth" | "skipped_below_threshold" | "rebuilt" |
 *           "rebuild_failed" | "disabled",
 *   delta: number,
 *   threshold: number,
 *   current_fact_count: number,
 *   last_rebuild_fact_count: number | null,
 *   result?: object,
 *   error?: string,
 *   reason?: string
 * }}
 */
export function maybeRunBm25Rebuild(opts = {}) {
  const ledgerPath =
    typeof opts.ledgerPath === "string" && opts.ledgerPath.length > 0
      ? opts.ledgerPath
      : memoryLedgerPath();
  const modelVersion =
    typeof opts.modelVersion === "string" && opts.modelVersion.length > 0
      ? opts.modelVersion
      : _defaultRebuildModelVersion();
  const threshold = Number.isFinite(opts.threshold)
    ? opts.threshold
    : CAPS.BM25_REBUILD_THRESHOLD;

  // CAPS-gated kill-switch: threshold = 0 disables the auto-trigger.
  if (!Number.isFinite(threshold) || threshold <= 0) {
    return {
      action: "disabled",
      delta: 0,
      threshold,
      current_fact_count: 0,
      last_rebuild_fact_count: null,
    };
  }

  // l11 — ARMING GATE (daemon seam only; rebuildBm25IndexFromLedger is
  // unaffected). daemons/watermark.js:2777 dispatches this function
  // ARGUMENT-LESS, so whatever _defaultRebuildModelVersion() resolves decides
  // which tree a long-running daemon overwrites without anyone asking. After
  // l11's retarget that default is CAPS.ACTIVE_EMBED_MODEL_VERSION — the tree
  // queryd is configured to serve (QUERYD_MODEL_VERSIONS=qwen3-embedding-8b-fp16
  // in ~/Library/LaunchAgents/com.user.memory-system.queryd.plist, read this
  // session). A full rebuild of the served tree is an OPERATOR action, and the
  // live-tree write guard in mcp/scripts/rebuild-bm25-index.mjs's main()
  // already encodes exactly that policy for the CLI seam: it refuses an
  // uncontained non-dry-run publish of the ACTIVE model ("refusing to publish
  // model_version=") and demands --memory-root=<TEMPDIR>. This is the same
  // policy at the daemon seam — the two read as one rule. b1 added a THIRD
  // reading of it inside rebuildBm25IndexFromLedger itself, so the rule now
  // holds for callers that are neither this seam nor that CLI.
  //
  // So: unless a target was chosen EXPLICITLY, return before any I/O. Env is
  // read at CALL time (see the JSDoc contract on _defaultRebuildModelVersion).
  //
  // CORRECTED 2026-08-17 (l7). This comment previously read "the watermark
  // plist sets none of these flags", which is FALSE and inverts the conclusion
  // a reader draws. `~/Library/LaunchAgents/com.user.memory-system.watermark.plist`
  // sets MEMORY_BM25_REBUILD_TARGET_ACTIVE=1 (read this session via
  // `/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables"`), alongside
  // MEMORY_BM25_REBUILD_OBJECT_ENTITIES=1 and
  // MEMORY_INCREMENTAL_AGGREGATION_ENABLED=1. The daemon's argument-less
  // maybeRunBm25Rebuild is therefore ARMED in production and CAN fire. What
  // keeps it off the legacy tree is not the arming gate but
  // _defaultRebuildModelVersion's step 2, which resolves that flag to
  // CAPS.ACTIVE_EMBED_MODEL_VERSION. An operator who read the old sentence
  // would conclude the periodic rebuild can never run at all, and would
  // mis-predict which tree a live rebuild writes.
  //
  // MEMORY_BM25_MODEL_NEUTRAL is deliberately NOT one of these terms. It is a
  // recall-side READ selector, consumed by resolveBm25Member in
  // lib/recall/bm25-projection.js to choose which bm25 path recall LOADS. It
  // still selects the target NAME via _defaultRebuildModelVersion above, but
  // naming a target is not authorization to write one.
  const explicitlyArmed =
    (typeof opts.modelVersion === "string" && opts.modelVersion.length > 0) ||
    process.env[BM25_REBUILD_TARGET_LEGACY_FLAG] === "1" ||
    process.env[BM25_REBUILD_TARGET_ACTIVE_FLAG] === "1";
  if (!explicitlyArmed) {
    return {
      action: "disabled",
      reason: "no_explicit_rebuild_target",
      delta: 0,
      threshold,
      current_fact_count: 0,
      last_rebuild_fact_count: null,
    };
  }

  const state = readRebuildState();
  // l11 — bm25-rebuild-state.json is ONE GLOBAL FILE, not per-model. Its
  // counts describe whichever tree the last rebuild wrote. Differencing a
  // fresh target's corpus against another tree's baseline is meaningless: it
  // reports a nonsense delta and, worse, skips forever. When the recorded
  // model does not match the resolved target, treat the state as absent for
  // DECISION purposes — genuine first-run semantics (delta = full fact count,
  // last_rebuild_fact_count = null), so the daemon's policy.bm25_index_rebuild
  // event can never publish a delta computed across two different trees.
  // An ABSENT last_rebuild_model_version (state files written before that key
  // existed) is NOT a mismatch: those stay backward compatible.
  const recordedModel =
    state && typeof state.last_rebuild_model_version === "string" &&
    state.last_rebuild_model_version.length > 0
      ? state.last_rebuild_model_version
      : null;
  const modelMismatch = recordedModel != null && recordedModel !== modelVersion;
  const effectiveState = modelMismatch ? null : state;
  const currentSize = ledgerSize(ledgerPath);
  const lastSize = effectiveState &&
    typeof effectiveState.last_rebuild_ledger_size === "number"
    ? effectiveState.last_rebuild_ledger_size
    : 0;
  const lastCount = effectiveState &&
    typeof effectiveState.last_rebuild_fact_count === "number"
    ? effectiveState.last_rebuild_fact_count
    : null;

  // Cheap pre-check: if the ledger has not grown since the last rebuild,
  // skip the streamed fact-count. Skipped entirely on a model mismatch — a
  // flat ledger must still get the new target its first build.
  if (effectiveState != null && currentSize <= lastSize) {
    return {
      action: "skipped_no_growth",
      delta: 0,
      threshold,
      current_fact_count: lastCount == null ? 0 : lastCount,
      last_rebuild_fact_count: lastCount,
    };
  }

  // Otherwise, count and decide — O(delta) via the growth-check sidecar
  // (W2); equivalent to the historical countFactRowsStreamed full stream.
  const { fact_count } = countFactRowsCheckpointed(ledgerPath);
  const delta = lastCount == null ? fact_count : fact_count - lastCount;
  if (effectiveState != null && delta < threshold) {
    return {
      action: "skipped_below_threshold",
      delta,
      threshold,
      current_fact_count: fact_count,
      last_rebuild_fact_count: lastCount,
    };
  }

  // Threshold met (or first run): perform the rebuild. On failure, leave
  // state untouched so the next tick re-tries against the same delta.
  let result;
  try {
    result = rebuildBm25IndexFromLedger({
      ledgerPath,
      modelVersion,
      // l11 — see the refusal in rebuildBm25IndexFromLedger. Set HERE only:
      // the periodic writer is the one caller that publishes over a tree
      // something else is already serving.
      refuseIfDropsObjectEntities: true,
      // b1 — and for exactly that reason it is also the ONE caller armed to
      // ride the live-tree write guard. Reaching this line already required
      // passing the explicitlyArmed gate above, so this seam's observable
      // behaviour is unchanged in both directions: armed still rebuilds,
      // unarmed still returns disabled/no_explicit_rebuild_target.
      allowLiveTreePublish: true,
    });
  } catch (err) {
    return {
      action: "rebuild_failed",
      delta,
      threshold,
      current_fact_count: fact_count,
      last_rebuild_fact_count: lastCount,
      error: err && err.message ? err.message : String(err),
    };
  }

  // A refusal is a FAILURE for trigger purposes, and deliberately reuses the
  // existing action string: it routes to the daemon's operator breadcrumb at
  // daemons/watermark.js:2794-2802, whose "the OLD index is intact" comment is
  // literally true here — nothing was written. State is NOT advanced, matching
  // the catch above ("leave state untouched so the next tick re-tries"), so
  // setting MEMORY_BM25_REBUILD_OBJECT_ENTITIES=1 makes the very next tick
  // succeed without any state surgery.
  if (result && typeof result.refused === "string") {
    return {
      action: "rebuild_failed",
      delta,
      threshold,
      current_fact_count: fact_count,
      last_rebuild_fact_count: lastCount,
      error: result.refused,
      result,
    };
  }

  // Persist new state. A persistence failure here is non-fatal: the index
  // is rebuilt; the next tick will re-stream and re-detect a "below
  // threshold" delta against the (still-old) state — at worst a redundant
  // rebuild on the next threshold crossing.
  try {
    writeRebuildState({
      last_rebuild_ts: new Date().toISOString(),
      last_rebuild_ledger_size: ledgerSize(ledgerPath),
      last_rebuild_fact_count: fact_count,
      last_rebuild_model_version: modelVersion,
    });
  } catch {
    // ignore — see comment above
  }

  return {
    action: "rebuilt",
    delta,
    threshold,
    current_fact_count: fact_count,
    last_rebuild_fact_count: lastCount,
    result,
  };
}

// Test-only escape hatch: clean up a stale .tmp left behind by an aborted
// rebuild. Production code does not call this — renameSync on a successful
// write removes the .tmp atomically, and a crashed run leaves the .tmp
// orphaned (which the next rebuild's writeFileAtomic harmlessly overwrites).
export function _cleanupTmp(modelVersion) {
  const { bm25Path } = indexPathsFor(modelVersion);
  const tmp = bm25Path + ".tmp";
  try {
    unlinkSync(tmp);
  } catch (e) {
    if (e && e.code === "ENOENT") return;
    throw e;
  }
}
