// index-cache.js — Phase 3 v0 process-scope cache for the BM25 + HNSW
// indices and the memory ledger reader.
//
// Authoritative spec source:
//   kb/research-retrieval-frontiers.md
//   § "Gemini integration specifics" → per `embedding_model_version` index.
// Authoritative shape contract:
//   kb/phase3-v0-contracts.md § 1 IndexEntry,
//   § 7 File layout.
//
// Cache invalidation strategy (S3):
//   - On every recall, this module statSync()s the active generation
//     manifest + loaded member paths; a changed fingerprint reloads via the
//     manifest-gated path (checksummed members, never mixed generations).
//     The WAL tail is absorbed on warm hits (S2y inode-pinned seq peek).
//   - Cache is keyed at module scope. Tests that override MEMORY_ROOT /
//     LEDGERS_BASE_DIR before importing memory-system modules get isolated
//     caches because the resolved path differs.
//   - If the index files are missing, the cache returns an empty in-memory
//     index (still usable; BM25.search and HNSW.search both return []). This
//     is the bootstrap case: a fresh ledger may have no per-version index on
//     disk yet, but recall must still respond.
//
// Ledger reader:
//   The ledger reader returns an array of parsed events from
//   ledgers/memory.jsonl. Used by recall.js to build IndexEntry shapes for
//   the candidate set. Embedding is left null on entries without one (the
//   Phase 1 fact does not have an embedding); the multi-feature scorer
//   tolerates this (s_emb_full3072=0 and predicate_mask=1 per the no-3072
//   branch in applyHardGates).

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
// S2 — single-writer lease + sequenced WAL for index mutations. The shared
// truncate-on-flush pending-adds.jsonl journal allowed a concurrent process's
// append to be ERASED by another process's flush (multi-process lost update),
// let warm cache hits miss other processes' appends, and let any process
// flush a stale base. index-wal.js replaces it: append-only crc-framed WAL,
// retirement by applied-cursor advance (never truncation), and an exclusive
// flush lease so exactly one process persists at a time.
import {
  WAL_FILE,
  // q1-index-generation-refusal — the flush-lease lock FILE NAME (never
  // hardcoded here): its presence + freshness is the cold-path evidence that a
  // publication (or another lease holder) is in flight, which distinguishes
  // the INTENDED mid-publish member/manifest skew from genuine corruption.
  WAL_LEASE_FILE,
  appendWalRecord,
  readWalTail,
  readAppliedCursor,
  advanceAppliedCursor,
  acquireFlushLease,
  heartbeatLease,
  releaseLease,
  compactWal,
  quarantineWal,
  // S2y — cross-process corruption strike (the 2-strike counter persisted to
  // disk so per-session MCP spawns still reach the quarantine path).
  readCorruptStrike,
  recordCorruptStrike,
  clearCorruptStrike,
} from "./index-wal.js";
// S3 — immutable generation manifest. Pre-S3 the index members (bm25.json,
// hnsw.bin, hnsw.bin.meta.json) were published as INDEPENDENT renames, so a
// crash between hnsw-index.js save()'s two renames (or a reader racing a
// save) paired a NEW graph binary with an OLD id map and an ANN label
// resolved to the WRONG fact id. index-manifest.js binds every member into
// ONE checksummed generation manifest published by a single atomic rename;
// this module loads ONLY what the active manifest names, verifies checksums
// before deserializing (cold path only — warm hits stay stat-level), refuses
// a mismatched member fail-closed, and falls back to the one retained prior
// generation.
import {
  MANIFEST_FILE,
  activateManifest,
  adoptGeneration0,
  buildManifest,
  checksumMemberFile,
  gcGenerations,
  readActiveManifest,
  retainActiveGeneration,
  retentionMemberNames,
  sameFileContentCheap,
  verifyGenerationMembers,
} from "./index-manifest.js";
import { MEMORY_ROOT, memoryLedgerPath } from "../config.js";
// WU-RR2b — the recall candidate-resolution step crashed on the 1.78 GB ledger
// because loadLedger() did readFileSync(ledgerPath, "utf8"), which throws
// ERR_STRING_TOO_LONG once memory.jsonl crosses Node's ~512 MiB
// MAX_STRING_LENGTH. Both readers below now stream via the shipped B1 helper.
import { streamLedgerLines } from "../synthesis/_ledger-stream.js";
// WU-recall-latency-fix — the recall candidate-resolution step was the measured
// dominant cost: loadLedgerRowsByIds streamed the whole 1.8 GB ledger per query
// (~5.2s, 83% of latency) just to materialize a few hundred candidate rows. The
// fix seeks each wanted row by BYTE OFFSET via a tail-merged offset index/sidecar
// instead of a full stream. seekLedgerRowsByIds is the offset-seek resolver; the
// legacy streamLedgerLines path below survives as a verified fallback.
import {
  seekLedgerRowsByIds,
  _resetOffsetCaches,
} from "./ledger-offset-index.js";
// WU-incrementalize-recall-recomputes — derivation-graph / entity-index /
// feature-backfill share a module-scope append-aware tail-merge cache. A
// hermetic test that rewrites its fixture ledger IN PLACE (not append-only)
// must clear it too, or a stale tail-merge could (safely) serve the old
// projection. Wire it into the standing _resetCaches escape hatch.
import { _resetAppendAwareProjectionCache } from "../synthesis/append-aware-ledger-projection.js";
import { Bm25Index } from "./bm25-index.js";
import { HNSW_BACKEND, HnswIndex } from "./hnsw-index.js";
import { CAPS } from "../validation.js";
// WORKUNIT A-promote-projection — the SINGLE valence projection. features.valence
// is now stamped as a structured {sign, magnitude, source, model_version} object
// on every NEW fact (promote chokepoint). The index/scorer layer consumes a
// scalar ∈ [-1,+1]; factValenceScalar is the one place that defines that
// projection so this rebuild path and updateIndicesForFact's incremental-add
// path never diverge (MAP finding N2.4).
import { factValenceScalar } from "../synthesis/valence-scorer.js";
import {
  isV2File as _isV2Bm25File,
  loadBm25IndexFromV2File as _loadBm25V2,
} from "./bm25-streaming-loader.js";
import { writeBm25IndexV2Atomic as _writeBm25V2 } from "./bm25-rebuild.js";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function indicesDir() {
  // Resolve indices/<embedding_model_version> from the current MEMORY_ROOT.
  // We do not memoize this — MEMORY_ROOT may be re-set between hermetic test
  // runs (and is captured at module load anyway, but the env override path
  // is what counts; tests set MEMORY_ROOT before any dynamic import).
  return join(MEMORY_ROOT, "indices");
}

function indexPathsFor(modelVersion) {
  const dir = join(indicesDir(), modelVersion);
  return {
    dir,
    bm25Path: join(dir, "bm25.json"),
    hnswPath: join(dir, "hnsw.bin"),
    // W2-debounced-index-persistence — self-contained pending-adds journal.
    // Lives INSIDE the per-model-version tree so pending state never crosses
    // model-version index trees (per-version index discipline).
    // S2: LEGACY — new appends go to the index-wal.jsonl WAL (index-wal.js,
    // same per-version dir). A non-empty legacy journal is still replayed on
    // fresh load (upgrade path) and is renamed — never unlinked — to
    // pending-adds.jsonl.migrated-<epoch-ms> after its records reach a saved
    // base generation.
    pendingPath: join(dir, "pending-adds.jsonl"),
    // S3 — the native-backend id-map sidecar and the generation manifest.
    // The ACTIVE generation's members always live at the fixed paths above
    // (formats byte-identical to pre-S3); the manifest is the publication
    // event that binds them.
    hnswMetaPath: join(dir, "hnsw.bin") + ".meta.json",
    manifestPath: join(dir, MANIFEST_FILE),
  };
}

// WU1-local-embedder-client-and-dim4096 — resolve the empty-HNSW fallback dim
// for a model version. The active local Qwen3 model indexes the full 4096-dim
// vectors; every other (legacy Gemini) version keeps the MRL-768 operating
// point. Exported so the dimension contract is directly unit-testable.
export function _emptyHnswDims(modelVersion) {
  if (modelVersion === CAPS.ACTIVE_EMBED_MODEL_VERSION) {
    return CAPS.EMBEDDING_DIM_4096;
  }
  return CAPS.GEMINI_EMBEDDING_DIMS_MRL;
}

// ---------------------------------------------------------------------------
// Stat fingerprint helper
// ---------------------------------------------------------------------------
function statFingerprint(path) {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "missing";
  }
}

// ---------------------------------------------------------------------------
// Index cache (module-scope)
// ---------------------------------------------------------------------------
// modelVersion -> { bm25, hnsw, generation, manifestFp,
//                   bm25Path, hnswPath, metaPath, bm25Fp, hnswFp, metaFp,
//                   walSeq, walOffset, walIno, walCorruptIno }
// S3: the cache identity is the generation identity — the manifest
// fingerprint plus the fingerprints of the exact member paths this entry was
// deserialized from (fixed paths normally; retention paths after a fallback
// load). generation is null for a legacy unmanaged entry.
const _indexCache = new Map();

// Warm-hit member identity: every stat is over the paths THIS entry actually
// loaded, so a fallback-loaded entry never false-hits against the (refused)
// fixed paths.
function _entryMemberFpsMatch(entry) {
  if (entry.bm25Fp !== statFingerprint(entry.bm25Path)) return false;
  if (entry.hnswFp !== statFingerprint(entry.hnswPath)) return false;
  if (
    entry.metaPath != null &&
    entry.metaFp !== statFingerprint(entry.metaPath)
  ) {
    return false;
  }
  return true;
}

export function loadIndices(modelVersion) {
  if (typeof modelVersion !== "string" || modelVersion.length === 0) {
    throw new TypeError("loadIndices: modelVersion required");
  }
  const { dir, bm25Path, hnswPath, hnswMetaPath, manifestPath } =
    indexPathsFor(modelVersion);

  // S3 MIGRATION — a pre-manifest tree (members on disk, no manifest) is
  // adopted as generation 0: checksum the current files, activate a gen-0
  // manifest, touch no member bytes. This is the one sanctioned write on the
  // read path (one-time per legacy tree); failure degrades to the legacy
  // unmanaged load below.
  let manifestFp = statFingerprint(manifestPath);
  if (
    manifestFp === "missing" &&
    (existsSync(bm25Path) || existsSync(hnswPath) || existsSync(hnswMetaPath))
  ) {
    // FIX (I4 fail-closed single-writer) — reader-side generation-0 adoption
    // is a manifest WRITE (activateManifest) and must hold the flush lease,
    // exactly like the publisher path (publishGeneration wraps adopt/retain/
    // activate in this same lease). Pre-fix this ran UNLEASED: a slow reader
    // that began adoption, while a publisher activated gen-1, then overwrote
    // the manifest back to gen-0 — a generation rollback that discarded the
    // WAL cursor and stranded facts. Acquire the lease, RE-STAT under it, and
    // adopt ONLY if the manifest is still missing. Without the lease we NEVER
    // adopt: re-stat and use a now-present manifest, else fall through to the
    // legacy-unmanaged serve with manifestFp still "missing".
    const adoptLease = _acquirePublishLease(dir);
    if (adoptLease != null) {
      try {
        manifestFp = statFingerprint(manifestPath);
        if (manifestFp === "missing") {
          const adoptCursor = readAppliedCursor(dir);
          const adopted = adoptGeneration0(dir, {
            wal_cursor: {
              applied_seq: adoptCursor.applied_seq,
              applied_offset: adoptCursor.applied_offset,
            },
          });
          if (adopted.error != null) {
            console.error(
              `index-cache: generation-0 adoption failed for ${modelVersion}: ` +
                `${JSON.stringify(adopted.error)}; serving legacy paths unmanaged`,
            );
          }
          manifestFp = statFingerprint(manifestPath);
        }
      } finally {
        releaseLease(adoptLease);
      }
    } else {
      // Lease busy — a publisher is mid-flight. Do NOT adopt unleased. Re-stat
      // (the publisher may have just activated a manifest we should use); else
      // leave manifestFp "missing" and fall through to the legacy serve.
      manifestFp = statFingerprint(manifestPath);
    }
  }

  const cached = _indexCache.get(modelVersion);
  // q1-index-generation-refusal — WARM-HIT IDENTITY.
  //
  // For a MANIFEST-MANAGED entry (generation != null AND a manifest exists on
  // disk) the manifest fingerprint ALONE is the cache identity. The member
  // fingerprints must NOT participate, because they legitimately change while
  // the manifest does not:
  //
  //   - index-manifest.js:10-12 — "a SINGLE atomic rename of that file (after
  //     file + dir fsync) is the only publication event". If the manifest has
  //     not moved, the active generation has not moved, so the generation this
  //     entry already holds is still exactly the one the active manifest names.
  //   - index-cache.js:1640-1646 — the publisher writes bm25.json and hnsw.bin
  //     at their FIXED paths BEFORE activating the manifest: "Until it lands,
  //     readers keep verifying against the OLD manifest". That window is
  //     INTENDED (it is what makes a crash leave either the old or the new
  //     generation fully active, never a mix) and in production it is tens of
  //     seconds wide for a 2.0 GB hnsw.bin.
  //
  // Pre-fix, ANDing _entryMemberFpsMatch here turned that intended window into
  // a warm-cache miss: queryd's 2s watch tick (mcp/daemon/queryd.js:565-592)
  // fell to the cold manifest-gated load, which verified the still-gen-N
  // manifest against the already-gen-N+1 bm25.json, REFUSED the active
  // generation on the size check, re-deserialized the whole 2.0 GB retained
  // generation synchronously, and stamped memory_recall with
  // degraded_reason:"index_generation_refused" on a completely healthy corpus
  // (78 such refusals in daemons/logs/queryd.stderr, 100% member=bm25).
  //
  // Safe because the deserialized generation is FULLY IN MEMORY: hnsw-index.js
  // reads with chunked readSync into a scratch buffer and closes the fd
  // (hnsw-index.js:774-777, :931-939) — no mmap, no retained fd — so bytes
  // changing at the fixed paths after the load cannot corrupt what we hold.
  //
  // Scope guard: every formerly out-of-band member writer now publishes through
  // publishGeneration and therefore always bumps the manifest (bm25-rebuild.js
  // :447, scripts/reembed-local-4096.mjs:667; heal-index-manifest.mjs writes no
  // members at all). A member rewrite with NO manifest rebind is no longer a
  // sanctioned state for a managed tree.
  //
  // LEGACY/UNMANAGED entries (generation == null, or no manifest on disk) have
  // no manifest to key on, so _entryMemberFpsMatch stays their ONLY change
  // signal — unchanged below.
  //
  // WAVE 2 — THE SUPPRESSION IS LEASE-BOUNDED, ON THIS PATH TOO. The first cut
  // of this gate dropped the member conjunct UNCONDITIONALLY for every managed
  // entry, which is wider than the licence above: the citations justify
  // ignoring a member rewrite that a PUBLICATION is performing, not ignoring
  // member bytes changing for any reason whatsoever. Unconditional suppression
  // would serve a warm entry forever through a genuine out-of-band corruption
  // (a truncated bm25.json, a botched manual copy) with nothing on stderr.
  // So the member mismatch is forgiven ONLY while the S2 flush lease is held
  // and FRESH — the same evidence, the same predicate (_publicationInFlight)
  // and the same CAPS.STALE_LOCK_RECOVERY_SECONDS bound the cold path uses.
  // Absent or stale lease ⇒ the entry is dropped and the cold walk runs, which
  // refuses loudly exactly as it always did. Fail-OPEN: _publicationInFlight
  // never throws and answers false on any stat error, so uncertainty always
  // resolves to today's loud behaviour, and suppression can never outlive
  // STALE_LOCK_RECOVERY_SECONDS (60s) of lock mtime.
  //
  // COST — the happy path pays NOTHING new. `_entryMemberFpsMatch(cached)` is
  // the LEFT operand of the ||, so on a steady-state warm hit (queryd's 2s
  // watch tick, the overwhelming majority of calls) it returns true and the
  // lease statSync is never evaluated. The one extra stat fires only inside a
  // publish window, where the alternative was a multi-GB re-deserialize.
  //
  // The 60s bound is comfortable against the real publisher timing:
  // heartbeatLease(lease) runs immediately before saveIndices on the flush
  // path (index-cache.js:2059), and the publisher writes the 23 MB bm25.json
  // FIRST (index-cache.js:1632) — and bm25 is the mismatching member in 100%
  // of the 78 observed refusals — so the first tick that sees the skew sees a
  // lease only seconds old.
  const cachedIsManaged =
    cached != null && cached.generation != null && manifestFp !== "missing";
  if (
    cached != null &&
    cached.manifestFp === manifestFp &&
    (_entryMemberFpsMatch(cached) ||
      (cachedIsManaged && _publicationInFlight(dir)))
  ) {
    // S2 warm-hit cross-process visibility: the fingerprints cover only the
    // manifest + member files, so a record appended to the WAL by ANOTHER
    // process since we last loaded would be invisible here. Absorb the WAL
    // tail into the cached indices before serving. Unchanged WAL costs
    // exactly one statSync (the size === entry.walOffset early return
    // inside). S3 cost note: the warm path stays stat-level — the manifest
    // is neither re-read nor re-verified here.
    _absorbWalTail(modelVersion, cached);
    // FU2 — the warm hit keeps reporting the entry's refusal marker until a
    // healthy fresh load (or a saveIndices reseed) replaces the entry.
    return {
      bm25: cached.bm25,
      hnsw: cached.hnsw,
      modelVersion,
      generation_refused: cached.generationRefused ?? null,
    };
  }

  let bm25 = null;
  let hnsw = null;
  let generation = null;
  let loadedPaths = null;
  let replayFrom = null; // non-null → a fallback generation's recorded cursor
  // FU2 — additive refusal marker: {code, member?, served: "fallback"|"empty"}
  // when the ACTIVE generation was refused and a non-active source served
  // this load (retained/previous fallback, or the fail-closed empty indices);
  // null on every healthy load.
  let generationRefused = null;

  if (manifestFp !== "missing") {
    // S3 manifest-gated load: deserialize ONLY the members the active
    // manifest names, checksums verified first (cold path — the warm hit
    // above never pays this). A mismatch REFUSES the generation fail-closed
    // (structured error) and falls back to the one retained prior
    // generation; with no valid generation left, recall degrades to empty
    // indices (this file's existing degrade discipline) — never a mixed
    // bin/meta/bm25 combination. A manifest that EXISTS but cannot be parsed
    // is also fail-closed: bypassing it in favor of raw member files would
    // reopen the mixed-generation window.
    //
    // FIX CYCLE 2 (reader race): verify -> deserialize is not atomic, and a
    // full-sha verify of multi-GB members widens the window to SECONDS. A
    // concurrent publisher's member renames landing inside it paired a
    // foreign graph with the verified generation's id map (wrong-fact-id
    // repro in review). The manifest fingerprint is captured BEFORE the
    // manifest read and re-statted AFTER deserialize (a completed concurrent
    // publication always moves it); _pickLoadableGeneration additionally
    // re-stats the candidate's member identities (ino:mtimeMs:size) after
    // deserialize to catch a publisher mid-flight (members renamed, manifest
    // not yet activated). Any change discards the deserialized candidate and
    // retries the walk — bounded, then fail-closed to empty indices with a
    // structured error (never the possibly-mixed candidate).
    const MAX_LOAD_ATTEMPTS = 3;
    let raceUnresolved = false;
    for (let attempt = 1; attempt <= MAX_LOAD_ATTEMPTS; attempt += 1) {
      const fpBefore =
        attempt === 1 ? manifestFp : statFingerprint(manifestPath);
      const mread = readActiveManifest(dir);
      if (mread.manifest == null) {
        console.error(
          `index-cache: unreadable index manifest for ${modelVersion}: ` +
            `${JSON.stringify(mread.error)}; fail-closed to empty indices`,
        );
        // FU2 — an unreadable-but-present manifest is a refusal of the whole
        // tree (nothing can be served through it): mark the empty serve.
        generationRefused = {
          code:
            mread.error != null && typeof mread.error.code === "string"
              ? mread.error.code
              : "index_manifest_unreadable",
          served: "empty",
        };
        break;
      }
      const pick = _pickLoadableGeneration(dir, modelVersion, mread.manifest);
      const fpAfter = statFingerprint(manifestPath);
      const raced =
        (pick != null && pick.raced === true) || fpAfter !== fpBefore;
      if (raced) {
        console.error(
          `index-cache: generation swap raced the load for ${modelVersion} ` +
            `(attempt ${attempt}/${MAX_LOAD_ATTEMPTS}); discarding candidate and retrying`,
        );
        if (attempt === MAX_LOAD_ATTEMPTS) {
          raceUnresolved = true;
          console.error(
            `index-cache: ${JSON.stringify({
              code: "index_generation_reader_race",
              model_version: modelVersion,
              attempts: MAX_LOAD_ATTEMPTS,
            })}; fail-closed to empty indices`,
          );
        }
        continue;
      }
      if (pick != null && pick.bm25 != null) {
        ({ bm25, hnsw, generation, loadedPaths, replayFrom } = pick);
      }
      // FU2 — the walk refused the ACTIVE candidate: stamp what actually
      // served this load (a non-active fallback generation, or — when no
      // candidate survived at all — the empty-index degrade below).
      if (pick != null && pick.activeRefusal != null) {
        generationRefused = {
          ...pick.activeRefusal,
          served: pick.bm25 != null ? "fallback" : "empty",
        };
      }
      manifestFp = fpBefore;
      break;
    }
    if (raceUnresolved) {
      // Poison the cache identity: an unresolved race must never warm-hit
      // the empty indices — the next loadIndices re-walks from disk.
      manifestFp = `reader-race-unresolved:${Date.now()}`;
      // FU2 — the unresolved race also fail-closes to empty indices: mark it
      // with the same structured code the stderr breadcrumb above carries.
      generationRefused = {
        code: "index_generation_reader_race",
        served: "empty",
      };
    }
    if (bm25 == null) bm25 = new Bm25Index();
    if (hnsw == null) {
      hnsw = new HnswIndex({
        dims: _emptyHnswDims(modelVersion),
        embedding_model_version: modelVersion,
      });
    }
  } else {
    // LEGACY (no manifest and nothing to adopt, or adoption failed): the
    // pre-S3 fixed-path load, unchanged.
    //
    // Load BM25. WU-RR1: large rebuilt indices use the v2 line-delimited
    // format (bm25-streaming-loader.js) because JSON.parse(readFileSync(...))
    // hits Node's MAX_STRING_LENGTH cap at ~512 MiB. v1 small indices (the
    // pre-WU-RR1 promote-time incremental shape) still load via the
    // JSON.parse path for back-compat.
    if (existsSync(bm25Path)) {
      try {
        if (_isV2Bm25File(bm25Path)) {
          bm25 = _loadBm25V2(bm25Path);
        } else {
          const data = JSON.parse(readFileSync(bm25Path, "utf8"));
          bm25 = Bm25Index.deserialize(data);
        }
      } catch (e) {
        console.error(
          `index-cache: failed to deserialize ${bm25Path}: ${e.message}; falling back to empty BM25`,
        );
        bm25 = new Bm25Index();
      }
    } else {
      bm25 = new Bm25Index();
    }

    // Load HNSW. WU1-local-embedder-client-and-dim4096 — the empty-index
    // fallback dim is model-versioned: the active local Qwen3 model indexes
    // the FULL 4096 vectors (operator chose full fidelity, no MRL slice),
    // while the legacy Gemini index stays on the MRL-768 operating point.
    // _emptyHnswDims selects by modelVersion so a fresh qwen3 index does not
    // silently build at 768 and reject 4096 adds.
    const emptyDims = _emptyHnswDims(modelVersion);
    if (existsSync(hnswPath) || existsSync(hnswMetaPath)) {
      try {
        hnsw = HnswIndex.load(hnswPath, { efSearch: 50 });
      } catch (e) {
        console.error(
          `index-cache: failed to load HNSW from ${hnswPath}: ${e.message}; falling back to empty HNSW`,
        );
        hnsw = new HnswIndex({
          dims: emptyDims,
          embedding_model_version: modelVersion,
        });
      }
    } else {
      hnsw = new HnswIndex({
        dims: emptyDims,
        embedding_model_version: modelVersion,
      });
    }
  }
  if (loadedPaths == null) {
    loadedPaths = {
      bm25Path,
      hnswPath,
      metaPath: existsSync(hnswMetaPath) ? hnswMetaPath : null,
    };
  }

  // W2-debounced-index-persistence — crash/staleness repair. If the
  // pending-adds journal is non-empty, the on-disk indices we just loaded may
  // be missing those adds (a flush was pending when the writing process died,
  // or another process simply has not flushed yet). Replay the journal
  // IDEMPOTENTLY into the freshly loaded in-memory indices. This runs ONLY on
  // the fresh-load path (cache miss / fingerprint change) — the cached-hit
  // early return above already holds the ahead-of-disk in-memory indices, so
  // read-your-writes never depends on this replay. The read path stays
  // write-free: we never flush from here; replayed adds persist on the next
  // scheduled flush (or the next full rebuild).
  _replayPendingAdds(modelVersion, bm25, hnsw);

  // S2 — replay the sequenced WAL from the applied cursor into the freshly
  // loaded indices, and remember {walSeq, walOffset} on the cache entry so
  // the warm-hit path above can absorb ONLY the new tail later (stat-only
  // when unchanged). Fail-closed on a tail error: apply nothing at/after the
  // bad record, keep the pre-error position (recall degrades to the persisted
  // base plus the valid WAL prefix — this file's existing degrade discipline).
  // S3 — when a FALLBACK generation was served, replay from THAT generation's
  // manifest-recorded cursor instead: the on-disk cursor may already be past
  // records the fallback base does not contain. A compaction that outran the
  // recorded cursor degrades to the full scan's seq > afterSeq filter
  // (idempotent; fail-closed on corruption) inside readWalTail.
  let replayStart = replayFrom;
  if (replayStart == null) {
    const cursor = readAppliedCursor(dir);
    if (cursor.error != null) {
      console.error(
        `index-cache: applied-cursor error for ${modelVersion}: ${cursor.error}; replaying WAL from 0 (idempotent)`,
      );
    }
    replayStart = {
      afterSeq: cursor.applied_seq,
      fromOffset: cursor.applied_offset,
    };
  }
  const tail = readWalTail(dir, replayStart, (rec) =>
    _applyAddRecord(rec, bm25, hnsw),
  );
  // S2d: on a corrupt record, pin the entry's marker to the corrupt WAL's
  // inode so subsequent WARM hits skip the (futile) re-scan — see
  // _absorbWalTail's pin discipline.
  // S2y (S2d-c TOCTOU closed): the pin is readWalTail's OWN fstat of the fd
  // it actually scanned — never a post-scan statSync of the path. Pre-S2y a
  // concurrent quarantine landing between the failed scan and the stat
  // pinned the FRESH healthy WAL's inode, freezing warm-hit absorption of
  // live appends until the next inode swap (T16).
  let walCorruptIno = null;
  if (tail.error != null) {
    console.error(
      `index-cache: WAL tail error for ${modelVersion}: ${tail.error}; applied valid prefix only`,
    );
    walCorruptIno = tail.ino ?? null;
  }

  _indexCache.set(modelVersion, {
    bm25,
    hnsw,
    generation,
    manifestFp,
    bm25Path: loadedPaths.bm25Path,
    hnswPath: loadedPaths.hnswPath,
    metaPath: loadedPaths.metaPath,
    bm25Fp: statFingerprint(loadedPaths.bm25Path),
    hnswFp: statFingerprint(loadedPaths.hnswPath),
    metaFp:
      loadedPaths.metaPath != null
        ? statFingerprint(loadedPaths.metaPath)
        : null,
    walSeq: tail.lastSeq,
    walOffset: tail.lastOffset,
    // S2y — the marker's identity: the inode of the WAL these {walSeq,
    // walOffset} were computed against (null when no WAL existed). The
    // warm-hit early return in _absorbWalTail is only valid against the
    // SAME inode.
    walIno: tail.ino ?? null,
    walCorruptIno,
    // FU2 — carried on the entry so warm hits keep reporting the refusal
    // until a healthy fresh load (or saveIndices reseed) replaces the entry.
    generationRefused,
  });
  return { bm25, hnsw, modelVersion, generation_refused: generationRefused };
}

// ---------------------------------------------------------------------------
// S3 — manifest-gated generation loading
// ---------------------------------------------------------------------------

// The ordered fallback chain for one active manifest:
//   1. "active"          — the manifest's members at the fixed paths.
//   2. "active-retained" — the SAME generation's retention snapshots
//      (*.gen-<N>.*), which exist iff a successor save started (it hardlinks
//      the active members before replacing the fixed paths). This is the
//      crash-between-renames window: the fixed paths are mixed, the
//      snapshots are intact, and the checksums are identical by inode.
//   3. "previous"        — the one retained prior generation the manifest
//      names, with its own recorded checksums + WAL cursor.
function _generationCandidates(dir, manifest) {
  const candidates = [
    {
      label: "active",
      generation: manifest.generation,
      members: manifest.members,
      cursor: null, // on-disk applied cursor (existing semantics)
    },
  ];
  let names = null;
  try {
    names = retentionMemberNames(manifest.generation);
  } catch (_e) {
    names = null;
  }
  if (names != null) {
    const retMembers = { bm25: null, hnsw: null, hnsw_meta: null };
    let anyRet = false;
    for (const key of ["bm25", "hnsw", "hnsw_meta"]) {
      const m = manifest.members != null ? (manifest.members[key] ?? null) : null;
      if (m == null) continue;
      retMembers[key] = { file: names[key], size: m.size, sha256: m.sha256 };
      if (existsSync(join(dir, names[key]))) anyRet = true;
    }
    if (anyRet) {
      candidates.push({
        label: "active-retained",
        generation: manifest.generation,
        members: retMembers,
        cursor: manifest.wal_cursor ?? null,
      });
    }
  }
  if (manifest.previous != null && manifest.previous.members != null) {
    candidates.push({
      label: "previous",
      generation: manifest.previous.generation,
      members: manifest.previous.members,
      cursor: manifest.previous.wal_cursor ?? null,
    });
  }
  return candidates;
}

// Test-only deterministic interleaving hook (reader-race suite): invoked
// after a candidate's checksum verify succeeds and BEFORE its members are
// deserialized — the exact window a concurrent publisher's member renames
// can land in. Production code never sets it; _resetCaches clears it.
let _afterVerifyHook = null;
export function _setAfterVerifyHook(fn) {
  _afterVerifyHook = typeof fn === "function" ? fn : null;
}

// FIX CYCLE 2 (reader race) — a candidate's member identities, ino:mtimeMs:
// size per non-null member, joined into one comparable string. Captured
// BEFORE verify (the full-sha read can take seconds on multi-GB members) and
// re-statted AFTER deserialize: every sanctioned member replacement is a
// rename (new inode), so identity equality across the whole verify->
// deserialize span proves the deserialized bytes are the verified bytes.
function _memberIdentityFps(dir, members) {
  const parts = [];
  for (const key of ["bm25", "hnsw", "hnsw_meta"]) {
    const m = members != null ? (members[key] ?? null) : null;
    if (m == null) continue;
    let fp = "missing";
    try {
      const st = statSync(join(dir, m.file));
      fp = `${st.ino}:${st.mtimeMs}:${st.size}`;
    } catch {
      fp = "missing";
    }
    parts.push(`${key}=${fp}`);
  }
  return parts.join("|");
}

// REG (memperf, S3g followup) — DESERIALIZE-REFUSAL BREADCRUMB. A generation
// that VERIFIES (checksums match) but fails deserialize is invisible to
// memory_health's stat-level index_generation_refused probe (sizes match the
// manifest; the bytes just don't decode — the gemini-embedding-001 incident
// class), so the refusal was stderr-only: recall served empty and nothing
// durable said why. The deserialize catch below persists a DERIVED,
// newest-wins index-refusal.json in the model-version dir (each refusal
// overwrites; best-effort — a breadcrumb write failure never turns a refusal
// into a crash) and the next SUCCESSFUL cold serve clears it. health.js
// reads it stat-level and emits `index_generation_refused: <mv>
// code=deserialize_failed`.
export const INDEX_REFUSAL_FILE = "index-refusal.json";

function _recordDeserializeRefusal(dir, modelVersion, cand, err) {
  try {
    writeFileSync(
      join(dir, INDEX_REFUSAL_FILE),
      JSON.stringify({
        code: "deserialize_failed",
        model_version: modelVersion,
        generation: cand.generation,
        label: cand.label,
        error: err && err.message ? err.message : String(err),
        ts: new Date().toISOString(),
      }) + "\n",
      { mode: 0o600 },
    );
  } catch {
    // best-effort breadcrumb — the stderr line above it already fired
  }
}

function _clearDeserializeRefusal(dir) {
  try {
    unlinkSync(join(dir, INDEX_REFUSAL_FILE));
  } catch {
    // ENOENT (the common case) or unwritable dir — nothing to clear
  }
}

// q1-index-generation-refusal — PUBLICATION-IN-FLIGHT PROBE. Cold path only
// (the warm hit above pays NO extra stat). Answers, for one statSync: does the
// S2 flush lease exist and is it FRESH — i.e. within CAPS
// .STALE_LOCK_RECOVERY_SECONDS of now, the same staleness bound
// index-wal.js's own stale-lock reclaim uses? A yes means the member/manifest
// skew a failed verifyGenerationMembers just observed is the INTENDED
// mid-publish window (index-cache.js:1640-1646), not corruption.
//
// Two honest limits, both deliberately left as-is:
//
//  (i) BOUNDED SUPPRESSION. The lease is heartbeaten exactly ONCE per publish,
//      and only on the WAL-flush path (index-cache.js:2059 / :2211); direct
//      publishGeneration callers (bm25-rebuild.js:447,
//      scripts/reembed-local-4096.mjs:667) never heartbeat at all. The lock's
//      mtime is therefore effectively the publish START time, so a publication
//      that outruns STALE_LOCK_RECOVERY_SECONDS (plausible for a 2.0 GB
//      hnsw.bin write plus two sha256 passes) reads as STALE here and this
//      probe stops suppressing. That is fail-OPEN: it degrades to exactly
//      today's loud REFUSING behaviour, which is the correct failure
//      direction. Do NOT "fix" it by heartbeating inside the publisher — the
//      publisher is out of scope for this change.
//
// (ii) IT ANSWERS "A LEASE HOLDER IS ACTIVE", NOT STRICTLY "MEMBERS ARE BEING
//      REWRITTEN". The same lease is taken by three holders: publishGeneration
//      (index-cache.js:1537), the WAL-flush path, and reader-side gen-0
//      adoption (index-cache.js:248). Suppression is therefore slightly wider
//      than the literal publish window. Acceptable because the suppressed
//      signal is only ever re-derived on the next load, and every non-fresh
//      case still refuses loudly.
//
// Never throws; any stat error (ENOENT, EACCES, …) answers false — uncertainty
// resolves to the loud path.
function _publicationInFlight(dir) {
  try {
    const st = statSync(join(dir, WAL_LEASE_FILE));
    return (
      Math.abs(Date.now() - st.mtimeMs) < CAPS.STALE_LOCK_RECOVERY_SECONDS * 1000
    );
  } catch {
    return false;
  }
}

// Verify-then-deserialize each candidate in order; the first survivor is
// served WHOLE (members never mix across candidates). All refusals are
// structured stderr breadcrumbs; null means no candidate survived AND the
// active candidate was never refused; {raced: true} means a member identity
// changed under a candidate mid-load and the CALLER must retry the walk
// (bounded) — never serve the possibly-mixed deserialization.
//
// FU2 (memperf) — IN-BAND refusal capture. When the ACTIVE candidate is
// refused (verify mismatch or deserialize failure) and a NON-ACTIVE source
// ends up serving (retained/previous fallback, or the caller's empty-index
// degrade), the refusal was previously stderr-only and recall reported
// degraded_recall:false — silent thin briefs (the live 1-14-vs-46-candidates
// incident). Capture the active candidate's structured refusal here:
//   - success return gains `activeRefusal` ({code, member?} | null);
//   - a no-survivor walk returns {activeRefusal} instead of null when the
//     active candidate was refused.
// The caller (loadIndices) stamps `served: "fallback"|"empty"` and threads
// the marker onto its return + cache entry.
function _pickLoadableGeneration(dir, modelVersion, manifest) {
  let activeRefusal = null;
  const noteActiveRefusal = (cand, code, member) => {
    if (cand.label !== "active" || activeRefusal != null) return;
    activeRefusal = {
      code:
        typeof code === "string" && code.length > 0
          ? code
          : "index_generation_refused",
      ...(typeof member === "string" && member.length > 0 ? { member } : {}),
    };
  };
  // q1-index-generation-refusal (wave 2) — NO SILENT DEGRADATION. Sibling of
  // noteActiveRefusal for the SUPPRESSED classification. Skipping the active
  // candidate because a publication is in flight is deliberately NOT a
  // refusal — that is this change's whole purpose — but the skip must never
  // buy silence. Captured first-wins, active-only, and surfaced ONLY by the
  // exhausted return below, which is reached exclusively when NOTHING was
  // served; loadIndices then stamps served:"empty" (index-cache.js:459-464)
  // and the marker rides out to queryd's status frame and the memory_recall
  // envelope. A successful fallback serve returns `activeRefusal` (still
  // null here) and stays undegraded.
  let activeInFlight = null;
  const noteActiveInFlight = (cand, member) => {
    if (cand.label !== "active" || activeInFlight != null) return;
    activeInFlight = {
      code: "index_publish_in_flight",
      ...(typeof member === "string" && member.length > 0 ? { member } : {}),
    };
  };
  for (const cand of _generationCandidates(dir, manifest)) {
    const fpsBefore = _memberIdentityFps(dir, cand.members);
    const v = verifyGenerationMembers(dir, cand.members);
    if (!v.ok) {
      // q1-index-generation-refusal — classify BEFORE refusing. A fresh flush
      // lease means a publication is in flight, so this mismatch is the
      // intended pre-activation window: emit a structurally distinct
      // breadcrumb and fall through to the retention snapshot WITHOUT
      // noteActiveRefusal, so `generation_refused` stays null and
      // memory_recall is not falsely degraded. No lease / stale lease → the
      // original loud path below runs unchanged.
      if (_publicationInFlight(dir)) {
        console.error(
          `index-cache: ${JSON.stringify({
            code: "index_publish_in_flight",
            model_version: modelVersion,
            generation: cand.generation,
            label: cand.label,
            member: v.error?.member ?? null,
          })}; serving the retained generation`,
        );
        noteActiveInFlight(cand, v.error?.member);
        continue;
      }
      console.error(
        `index-cache: REFUSING index generation ${cand.generation} (${cand.label}) ` +
          `for ${modelVersion}: ${JSON.stringify(v.error)}`,
      );
      noteActiveRefusal(cand, v.error?.code, v.error?.member);
      continue;
    }
    if (_afterVerifyHook != null) _afterVerifyHook(cand);
    try {
      const { bm25, hnsw, loadedPaths } = _deserializeGenerationMembers(
        dir,
        modelVersion,
        cand.members,
      );
      const fpsAfter = _memberIdentityFps(dir, cand.members);
      if (fpsAfter !== fpsBefore) {
        console.error(
          `index-cache: generation ${cand.generation} (${cand.label}) members ` +
            `changed between verify and deserialize for ${modelVersion}; ` +
            `discarding candidate (reader race)`,
        );
        return { raced: true };
      }
      if (cand.label !== "active") {
        console.error(
          `index-cache: serving retained fallback generation ${cand.generation} ` +
            `(${cand.label}) for ${modelVersion}`,
        );
      }
      const c = cand.cursor;
      const replayFrom =
        c != null &&
        Number.isSafeInteger(c.applied_seq) &&
        Number.isSafeInteger(c.applied_offset)
          ? { afterSeq: c.applied_seq, fromOffset: c.applied_offset }
          : null;
      // REG (FU2 fix) — clear the deserialize-refusal breadcrumb ONLY when the
      // ACTIVE generation itself serves. A non-active FALLBACK serve
      // (activeRefusal != null) must LEAVE index-refusal.json intact so
      // memory_health keeps surfacing the refused active generation — pre-fix
      // ANY successful candidate (including the retained fallback) erased it,
      // and health went silent about a refused active generation the instant a
      // fallback served. (The raced return above deliberately does NOT clear
      // either: nothing was served.)
      if (cand.label === "active") _clearDeserializeRefusal(dir);
      return {
        bm25,
        hnsw,
        generation: cand.generation,
        loadedPaths,
        replayFrom,
        activeRefusal,
      };
    } catch (e) {
      console.error(
        `index-cache: failed to deserialize verified generation ${cand.generation} ` +
          `(${cand.label}) for ${modelVersion}: ${e.message}`,
      );
      noteActiveRefusal(cand, "deserialize_failed", null);
      // REG — persist the newest-wins breadcrumb so memory_health can
      // surface what stderr alone could not (see INDEX_REFUSAL_FILE above).
      _recordDeserializeRefusal(dir, modelVersion, cand, e);
    }
  }
  // The walk is exhausted and NOTHING served. A loud refusal wins the marker;
  // otherwise, if the active candidate was skipped as in-flight, that skip is
  // what the caller must report — returning bare null here would degrade
  // recall to the empty index with generation_refused === null, i.e. exactly
  // the silent degradation this file exists to prevent. Bare null now means
  // only "no candidate survived and none was skipped by us".
  if (activeRefusal != null) return { activeRefusal };
  if (activeInFlight != null) return { activeRefusal: activeInFlight };
  return null;
}

// Deserialize one verified candidate's members. THROWS on failure — the
// caller treats that as the whole candidate failing (never serve a partial
// generation). A null member is the bootstrap empty index (same semantics as
// the pre-S3 missing-file branches).
function _deserializeGenerationMembers(dir, modelVersion, members) {
  const { bm25Path, hnswPath } = indexPathsFor(modelVersion);
  let bm25;
  let bm25LoadedPath = bm25Path;
  if (members.bm25 != null) {
    bm25LoadedPath = join(dir, members.bm25.file);
    if (_isV2Bm25File(bm25LoadedPath)) {
      bm25 = _loadBm25V2(bm25LoadedPath);
    } else {
      bm25 = Bm25Index.deserialize(
        JSON.parse(readFileSync(bm25LoadedPath, "utf8")),
      );
    }
  } else {
    bm25 = new Bm25Index();
  }
  let hnsw;
  let hnswLoadedPath = hnswPath;
  let metaPath = null;
  if (members.hnsw != null) {
    // HnswIndex.load probes `<path>.meta.json` for the native sidecar; the
    // retention naming (hnsw.gen-N.bin + .meta.json) preserves that suffix,
    // so retained generations load with zero special-casing.
    hnswLoadedPath = join(dir, members.hnsw.file);
    hnsw = HnswIndex.load(hnswLoadedPath, { efSearch: 50 });
    if (members.hnsw_meta != null) {
      metaPath = join(dir, members.hnsw_meta.file);
    }
  } else {
    hnsw = new HnswIndex({
      dims: _emptyHnswDims(modelVersion),
      embedding_model_version: modelVersion,
    });
  }
  return {
    bm25,
    hnsw,
    loadedPaths: { bm25Path: bm25LoadedPath, hnswPath: hnswLoadedPath, metaPath },
  };
}

// _absorbWalTail — S2 warm-hit visibility. Replays WAL records appended
// since the cache entry's {walSeq, walOffset} marker into the CACHED
// in-memory indices, then advances the marker. Cost discipline: an unchanged
// WAL is exactly one statSync; a grown WAL is a tail-seek proportional to the
// NEW records only (readWalTail's fast path). Entries created by a direct
// saveIndices call carry no marker yet — those bootstrap from the applied
// cursor (everything <= cursor is already in the base that fingerprint-
// matched; replay past it is idempotent anyway).
function _absorbWalTail(modelVersion, entry) {
  const { dir } = indexPathsFor(modelVersion);
  let st;
  try {
    st = statSync(join(dir, WAL_FILE));
  } catch {
    return; // no WAL — nothing to absorb
  }
  const size = st.size;
  // S2d degradation cap: after a corrupt-record error the marker is PINNED to
  // the corrupt file's inode. Without the pin, every warm hit re-ran the
  // strict fast path into the corrupt record, fell back, and FULL-SCANNED the
  // whole WAL — per request, while appends kept growing the file. Appends
  // never change the inode, so `same inode` ⇔ `same corrupt WAL` and the
  // absorb is skipped for the statSync cost alone. Only a WAL REPLACEMENT
  // (S2d quarantine, or compaction — both swap in a new inode) clears the
  // pin, at which point we re-bootstrap from the applied cursor.
  let bootstrapped = false;
  if (entry.walCorruptIno != null) {
    if (st.ino === entry.walCorruptIno) return;
    entry.walCorruptIno = null;
    const cursor = readAppliedCursor(dir);
    entry.walSeq = cursor.error == null ? cursor.applied_seq : 0;
    entry.walOffset = cursor.error == null ? cursor.applied_offset : 0;
    entry.walIno = null; // identity unknown until the scan below re-learns it
    bootstrapped = true;
  }
  let afterSeq = entry.walSeq;
  let fromOffset = entry.walOffset;
  if (!Number.isSafeInteger(afterSeq) || !Number.isSafeInteger(fromOffset)) {
    const cursor = readAppliedCursor(dir);
    afterSeq = cursor.error == null ? cursor.applied_seq : 0;
    fromOffset = cursor.error == null ? cursor.applied_offset : 0;
    bootstrapped = true;
  }
  if (size === fromOffset) {
    // S2y (S2c residue closed): byte-offset equality is NOT identity for the
    // IN-MEMORY marker either — another process's compaction swaps the WAL
    // (new inode) and a regrowth to EXACTLY the cached walOffset would alias
    // "unchanged" and silently skip never-applied records (T13). The early
    // return is taken only when the inode still matches the marker's
    // last-seen WAL (same discipline the walCorruptIno pin proved: every
    // sanctioned WAL replacement swaps the inode; appends never do). An
    // empty WAL at offset 0 can hide nothing, so it is trivially safe — and
    // is the normal post-compaction state, where we cheaply learn the fresh
    // inode from the stat we already paid for.
    if (size === 0 || (entry.walIno != null && st.ino === entry.walIno)) {
      // Unchanged WAL: the statSync above was the whole cost.
      entry.walSeq = afterSeq;
      entry.walOffset = fromOffset;
      if (size === 0) entry.walIno = st.ino;
      return;
    }
    // Identity unproven: re-bootstrap from the applied cursor and let
    // readWalTail verify (its S2c EOF seq-peek / full-scan seq filter).
    if (!bootstrapped) {
      const cursor = readAppliedCursor(dir);
      afterSeq = cursor.error == null ? cursor.applied_seq : 0;
      fromOffset = cursor.error == null ? cursor.applied_offset : 0;
    }
  }
  const tail = readWalTail(dir, { afterSeq, fromOffset }, (rec) =>
    _applyAddRecord(rec, entry.bm25, entry.hnsw),
  );
  if (tail.error != null) {
    console.error(
      `index-cache: WAL tail error for ${modelVersion}: ${tail.error}; ` +
        `applied valid prefix only (marker pinned until the WAL is quarantined/compacted)`,
    );
    // S2y (S2d-c audit): the pre-scan `st` above and readWalTail's own fd
    // fstat are BOTH taken before any concurrent quarantine could swap the
    // path — pinning either is TOCTOU-safe, unlike a post-scan statSync.
    // Prefer the fd's inode (the file readWalTail actually scanned); the
    // pre-scan st.ino is the fallback for exotic fstat failures.
    entry.walCorruptIno = tail.ino ?? st.ino;
  }
  entry.walSeq = tail.lastSeq;
  entry.walOffset = tail.lastOffset;
  entry.walIno = tail.ino ?? st.ino;
}

// _applyAddRecord — shared idempotent apply for one self-contained add record
// {fact_id, ts, bm25_entry, vector} (WAL replay AND legacy pending-adds
// replay). Idempotency contract: a fact already present in BOTH indices is
// skipped outright; a fact present in only one is added to the missing one
// only (covers the flush-succeeded-but-retire-crashed window AND a
// bm25-only/hnsw-only partial persist). A single bad record degrades to a
// stderr breadcrumb, never a failed load.
function _applyAddRecord(rec, bm25, hnsw) {
  if (
    rec == null ||
    typeof rec !== "object" ||
    typeof rec.fact_id !== "string" ||
    rec.fact_id.length === 0
  ) {
    console.error("index-cache: skipping malformed index-add record");
    return false;
  }
  try {
    const inHnsw = hnsw.has(rec.fact_id);
    const inBm25 = bm25._docLen instanceof Map && bm25._docLen.has(rec.fact_id);
    if (inHnsw && inBm25) return false; // already fully indexed — idempotent skip
    if (
      !inBm25 &&
      rec.bm25_entry != null &&
      typeof rec.bm25_entry === "object"
    ) {
      // The record carries the exact entry object that was handed to
      // bm25.add at promote time; re-pin memory_id to fact_id defensively.
      bm25.add({ ...rec.bm25_entry, memory_id: rec.fact_id });
    }
    if (!inHnsw && Array.isArray(rec.vector) && rec.vector.length > 0) {
      hnsw.add(rec.fact_id, rec.vector);
    }
    return true;
  } catch (e) {
    // Defensive: a single bad record (wrong dims, non-unit vector, ...)
    // degrades to a breadcrumb, never a failed load.
    console.error(
      `index-cache: index-add replay failed for ${rec.fact_id}: ${e.message}`,
    );
    return false;
  }
}

// _replayPendingAdds — replay each parseable pending-adds.jsonl line into the
// in-memory bm25 + hnsw. Idempotency contract: a fact already present in BOTH
// indices is skipped outright; a fact present in only one is added to the
// missing one only (covers the flush-succeeded-but-truncate-crashed window
// AND a bm25-only/hnsw-only partial persist). Malformed lines are skipped
// with a stderr breadcrumb — matches this file's existing degrade discipline
// (one corrupt line must never poison the load). NEVER reads
// ledgers/memory.jsonl: each journal line is self-contained
// {fact_id, ts, bm25_entry, vector}.
function _replayPendingAdds(modelVersion, bm25, hnsw) {
  const { pendingPath } = indexPathsFor(modelVersion);
  if (!existsSync(pendingPath)) return 0;
  // Bounded read: this legacy journal stopped growing at the S2 cutover (new
  // appends go to the WAL) and is renamed to *.migrated-<epoch-ms> at the
  // first successful flush after upgrade, so its size is the pre-upgrade
  // pending tail (< INDEX_SAVE_BATCH lines, ~40-80 KB each).
  let raw;
  try {
    raw = readFileSync(pendingPath, "utf8");
  } catch (e) {
    console.error(
      `index-cache: failed to read pending-adds journal ${pendingPath}: ${e.message}; skipping replay`,
    );
    return 0;
  }
  if (raw.length === 0) return 0;
  let replayed = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let rec = null;
    try {
      rec = JSON.parse(trimmed);
    } catch (_e) {
      rec = null;
    }
    if (
      rec == null ||
      typeof rec !== "object" ||
      typeof rec.fact_id !== "string" ||
      rec.fact_id.length === 0
    ) {
      console.error(
        `index-cache: skipping malformed pending-adds line in ${pendingPath}`,
      );
      continue;
    }
    // S2: shared idempotent apply (same guards the WAL replay uses).
    if (_applyAddRecord(rec, bm25, hnsw)) replayed += 1;
  }
  return replayed;
}

// saveIndices — persist BM25 + HNSW to disk under
// indices/<modelVersion>/{bm25.json,hnsw.bin}. Used by promote-time wiring in
// distill-promote-fact.js and by the backfill script. The cache fingerprint is
// refreshed in-place so the next loadIndices() in the same process does NOT
// re-deserialize from disk (avoids losing the in-memory adds when stat
// granularity is coarse, e.g. macOS HFS+ 1-second mtime). Per-version index
// discipline: indices live under indices/<modelVersion>/; never overwrite a
// different model version's tree.
//
// S2 LOCKING NOTE: the single-writer flush lease guards ONLY the debounced
// flush path (_flushPendingSaves). saveIndices itself is deliberately
// unguarded — offline rebuild/backfill scripts call it directly while the
// system is quiesced.
//
// S3 GENERATION PUBLICATION: the members are still written to the fixed
// paths in the same formats, but the PUBLICATION event is now the single
// atomic rename of the generation manifest (activateManifest), performed
// strictly AFTER the member writes. Before the fixed paths are replaced, the
// outgoing generation is hardlink-retained under generation-addressed names
// as the ONE fallback; older retention generations are GC'd afterwards. The
// third parameter is optional and internal: _flushPendingSaves passes the
// CAPTURED WAL cursor {applied_seq, applied_offset} so the manifest embeds
// it verbatim; 2-arg callers (rebuild/backfill, tests) embed the current
// on-disk applied cursor — the API stays byte-compatible for them.
export function saveIndices(modelVersion, { bm25, hnsw } = {}, opts = {}) {
  if (typeof modelVersion !== "string" || modelVersion.length === 0) {
    throw new TypeError("saveIndices: modelVersion required");
  }
  if (!bm25 || !hnsw) {
    throw new TypeError("saveIndices: both bm25 and hnsw must be provided");
  }
  // FIX CYCLE 2 — the write/checksum/activate/GC pipeline is factored into
  // publishGeneration (the ONE publication seam every writer shares).
  // saveIndices keeps only what is specific to holding both LIVE in-memory
  // indices: re-seeding the process cache so the next loadIndices serves the
  // ahead-of-disk objects without re-deserializing.
  const { manifest } = publishGeneration(modelVersion, { bm25, hnsw }, opts);
  const { bm25Path, hnswPath, hnswMetaPath, manifestPath } =
    indexPathsFor(modelVersion);
  _indexCache.set(modelVersion, {
    bm25,
    hnsw,
    generation: manifest.generation,
    manifestFp: statFingerprint(manifestPath),
    bm25Path,
    hnswPath,
    metaPath: manifest.members.hnsw_meta != null ? hnswMetaPath : null,
    bm25Fp: statFingerprint(bm25Path),
    hnswFp: statFingerprint(hnswPath),
    metaFp:
      manifest.members.hnsw_meta != null ? statFingerprint(hnswMetaPath) : null,
    // FU2 — a successful publication IS the healthy generation: clear any
    // refusal marker a prior refused load left on the entry.
    generationRefused: null,
  });
}

// _carryMember — FIX CYCLE 2 partial-publish support. For a member this
// publication did NOT rewrite, carry the active manifest's recorded checksum
// forward (the fixed-path bytes are unchanged — re-hashing a multi-GB member
// per partial publish would fight the perf gate). If the on-disk size
// visibly diverged from the record (an unbound out-of-band write landed
// there), re-checksum what is actually on disk — binding the real bytes
// beats publishing a generation that is refused on its first load; if the
// file is missing, publish without the member (bootstrap-empty semantics).
function _carryMember(dir, recorded, file, snapshotPath = null) {
  const p = join(dir, file);
  if (recorded != null) {
    let st = null;
    try {
      st = statSync(p);
    } catch (_e) {
      st = null;
    }
    if (st == null) {
      console.error(
        `index-cache: carried member ${file} missing on disk; publishing without it`,
      );
      return null;
    }
    // FIX (I5 content-identity carry) — never carry a recorded digest on bare
    // size equality: an out-of-band SAME-SIZE foreign replacement of the fixed
    // path passes a size-only check and binds a stale sha over foreign bytes,
    // publishing a generation that is REFUSED on its very next cold load
    // (recorded sha != on-disk bytes). Retention hardlinked the recorded bytes
    // into snapshotPath BEFORE any member write, so sameFileContentCheap is an
    // O(1) dev+ino identity hit in the normal (unchanged) case and carries the
    // recorded digest verbatim. A foreign replacement (new inode) — or no
    // fresh snapshot (retention degraded / previous is an older generation /
    // snapshot missing) — re-checksums the ACTUAL on-disk bytes so the manifest
    // binds the real digest, mirroring the existing size-divergence branch.
    if (snapshotPath != null && sameFileContentCheap(p, snapshotPath)) {
      return { file: recorded.file, size: recorded.size, sha256: recorded.sha256 };
    }
    console.error(
      `index-cache: carried member ${file} is not byte-identical to its ` +
        `retention snapshot (or no fresh snapshot exists); re-checksumming the ` +
        `on-disk bytes`,
    );
    return checksumMemberFile(dir, file);
  }
  if (existsSync(p)) return checksumMemberFile(dir, file);
  return null;
}

// FIX (F1) — bind the hnsw_meta member for a FRESH hnsw write from the save
// ARTIFACT, never from a stale on-disk sidecar probe.
//   - saved.metaPath non-null (native save): checksum + bind the sidecar.
//   - saved.metaPath null (linear save): bind NO meta AND remove any stale
//     native hnsw.bin.meta.json from a prior native save so HnswIndex.load
//     does not take the native branch over the fresh linear bin (the exact
//     permanent-refusal/churn this fix closes). Retention already hardlinked
//     any RECORDED meta into hnsw.gen-N.bin.meta.json before the member
//     writes, so unlinking the LIVE path never touches the retained fallback
//     (I6). Best-effort unlink — ENOENT (the common case) is fine.
//   - saved == null (function-writer returned no artifact): fall back to the
//     on-disk probe; the coherence gate at the call site catches an
//     incoherent pair.
function _bindFreshHnswMeta(dir, hnswMetaPath, saved) {
  if (saved != null) {
    if (saved.metaPath != null) {
      return checksumMemberFile(dir, "hnsw.bin.meta.json");
    }
    try {
      unlinkSync(hnswMetaPath);
    } catch (_e) {
      // nothing stale to remove (or unwritable) — never fail the publish
    }
    return null;
  }
  return existsSync(hnswMetaPath)
    ? checksumMemberFile(dir, "hnsw.bin.meta.json")
    : null;
}

// S2y — bounded head read of hnsw.bin: the linear-scan NDJSON format's first
// line is a small JSON header {format, backend, dims,
// embedding_model_version, ...} (hnsw-index.js save()). Returns the parsed
// header object, or null when the file does not start with such a line (the
// hnswlib-node native binary, or anything unreadable). NEVER reads more than
// one chunk — production hnsw.bin is multi-GB.
const HNSW_HEADER_PROBE_BYTES = 64 * 1024;
function _readHnswBinHeader(p) {
  let fd = null;
  try {
    fd = openSync(p, "r");
    const buf = Buffer.alloc(HNSW_HEADER_PROBE_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n <= 0) return null;
    const nl = buf.indexOf(0x0a);
    const line = buf.subarray(0, nl >= 0 && nl < n ? nl : n).toString("utf8");
    const h = JSON.parse(line);
    if (h != null && typeof h === "object" && typeof h.backend === "string") {
      return h;
    }
    return null;
  } catch (_e) {
    return null;
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

// S2y — coherence probe for an UNRECORDED hnsw member pair about to be
// carried into a manifest (_carryMember's existsSync→checksum branch). The
// active manifest never vouched for these bytes, and binding an incoherent
// bin/meta pair produces a generation that VERIFIES on every cold load
// (checksums match the incoherent bytes) and then fails to deserialize —
// permanent fallback churn. Rules mirror HnswIndex.load's routing AND the
// current runtime's decode ability (a member no cold load on this host can
// deserialize is refused for the same reason):
//   - meta sidecar present  → load takes the native branch. Coherent only if
//     the bin is NOT a linear-scan single file, the meta carries a sane
//     native shape ({backend:"hnswlib-node", integer dims, string model}),
//     and the native backend is actually available. A linear-scan bin under
//     any meta is a field disagreement (backend, then dims, then
//     embedding_model_version — first mismatch reported).
//   - meta sidecar absent   → load takes the single-file branch. Coherent
//     only if the bin head parses as the linear-scan header and the runtime
//     decodes linear-scan single files.
// Returns {ok: true} or {ok: false, reason}.
function _carriedHnswPairCoherent(dir) {
  const binHeader = _readHnswBinHeader(join(dir, "hnsw.bin"));
  const metaPath = join(dir, "hnsw.bin.meta.json");
  if (!existsSync(metaPath)) {
    if (binHeader == null) {
      return {
        ok: false,
        reason: "opaque binary hnsw.bin without its id-map meta sidecar",
      };
    }
    if (binHeader.backend !== "linear-scan") {
      return {
        ok: false,
        reason: `single-file hnsw.bin claims backend ${JSON.stringify(binHeader.backend)} (only linear-scan is single-file)`,
      };
    }
    if (HNSW_BACKEND !== "linear-scan") {
      return {
        ok: false,
        reason: `single-file linear-scan hnsw.bin is not decodable on the ${HNSW_BACKEND} runtime`,
      };
    }
    return { ok: true };
  }
  let meta = null;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch (e) {
    return { ok: false, reason: `meta sidecar unreadable: ${e.message}` };
  }
  if (meta == null || typeof meta !== "object" || typeof meta.backend !== "string") {
    return { ok: false, reason: "meta sidecar malformed (no backend)" };
  }
  if (binHeader != null) {
    // A meta sidecar routes HnswIndex.load down the native branch, which can
    // never load a linear-scan single file — any such pair is incoherent;
    // report the FIRST field disagreement for the breadcrumb.
    if (meta.backend !== binHeader.backend) {
      return {
        ok: false,
        reason: `backend disagreement: bin header ${JSON.stringify(binHeader.backend)} vs meta ${JSON.stringify(meta.backend)}`,
      };
    }
    if (Number.isInteger(binHeader.dims) && Number.isInteger(meta.dims) && binHeader.dims !== meta.dims) {
      return {
        ok: false,
        reason: `dims disagreement: bin header ${binHeader.dims} vs meta ${meta.dims}`,
      };
    }
    if (
      typeof binHeader.embedding_model_version === "string" &&
      typeof meta.embedding_model_version === "string" &&
      binHeader.embedding_model_version !== meta.embedding_model_version
    ) {
      return {
        ok: false,
        reason:
          `embedding_model_version disagreement: bin header ` +
          `${JSON.stringify(binHeader.embedding_model_version)} vs meta ` +
          `${JSON.stringify(meta.embedding_model_version)}`,
      };
    }
    return {
      ok: false,
      reason: "meta sidecar present alongside a single-file linear-scan hnsw.bin",
    };
  }
  if (meta.backend !== "hnswlib-node") {
    return {
      ok: false,
      reason: `binary hnsw.bin under a non-native meta backend ${JSON.stringify(meta.backend)}`,
    };
  }
  if (!Number.isInteger(meta.dims) || typeof meta.embedding_model_version !== "string") {
    return { ok: false, reason: "native meta sidecar missing dims/embedding_model_version" };
  }
  if (HNSW_BACKEND !== "hnswlib-node") {
    // Mirrors _loadNativeSidecar's own fail-closed throw on a linear runtime.
    return {
      ok: false,
      reason: "native hnsw pair is not decodable on the linear-scan runtime",
    };
  }
  return { ok: true };
}

// S2y — bounded-wait flush-lease acquisition for OUT-OF-BAND publishers
// (daemon bm25 rebuild, reembed/backfill scripts, direct saveIndices
// callers). acquireFlushLease itself is non-blocking by design; this retry
// loop (short sync spin, matching acquireAppendLock's discipline) gives an
// uncontended publish its lease immediately and a contended one a small
// bounded window before the caller falls back to its structured skip.
const PUBLISH_LEASE_WAIT_MS_DEFAULT = 250;
function _acquirePublishLease(dir, waitMs) {
  const budget =
    Number.isFinite(waitMs) && waitMs >= 0 ? waitMs : PUBLISH_LEASE_WAIT_MS_DEFAULT;
  const start = Date.now();
  for (;;) {
    const lease = acquireFlushLease(dir);
    if (lease != null) return lease;
    if (Date.now() - start >= budget) return null;
    const deadline = Date.now() + 25;
    while (Date.now() < deadline) {
      // intentional short sync spin (matches index-wal.js acquireAppendLock)
    }
  }
}

/**
 * publishGeneration — FIX CYCLE 2: the ONE sanctioned publication seam for
 * EVERY index writer (the review's deployment-blocker was three out-of-band
 * writers rewriting members at the fixed paths with no manifest rebind:
 * bm25-rebuild.js's daemon rebuild, reembed-local-4096.mjs's --build-hnsw,
 * and backfill-embeddings.mjs — the manifest-gated loader then REFUSED the
 * whole generation on the next cold load, and on a previous-less tree recall
 * served EMPTY indices until the next saveIndices).
 *
 * Pipeline (exactly saveIndices' pre-fix internals):
 *   adopt-if-needed → retainActiveGeneration → member write(s) →
 *   checksumMemberFile → buildManifest → activateManifest → gcGenerations.
 *
 * @param {string} modelVersion — per-version index discipline key.
 * @param {{bm25?, hnsw?}} members — at least one required. Each is either
 *   the index OBJECT (default writers: the same v2 bm25 stream / hnsw.save
 *   the flush path uses) or a writer CALLBACK `(fixedPath) => any` for
 *   out-of-band writers that own their byte format. Every writer MUST
 *   replace the fixed path via tmp+rename — NEVER in place: retention
 *   hardlinks share the inode, so an in-place write corrupts the immutable
 *   fallback snapshot. An hnsw callback may return the save() artifact
 *   binding ({backend, dims, format, embedding_model_version}) to stamp the
 *   manifest's model metadata.
 * @param {{walCursor?: {applied_seq, applied_offset}}} opts — the flush
 *   path's CAPTURED cursor, embedded verbatim; absent → the on-disk applied
 *   cursor (2-arg semantics, unchanged).
 * @returns {{manifest: object, dir: string}}
 *
 * Partial publishes carry the unchanged members' recorded checksums forward
 * from the active manifest and re-checksum only the rewritten members.
 * THROWS on writer/manifest failure (save-path contract) — including,
 * fail-closed, on a manifest that EXISTS but cannot be parsed (followup b:
 * pre-fix that fell through to adoptGeneration0, silently re-adopting
 * generation 0 over the corrupt manifest and destroying the lineage and its
 * retained fallback).
 */
export function publishGeneration(modelVersion, { bm25 = null, hnsw = null } = {}, opts = {}) {
  if (typeof modelVersion !== "string" || modelVersion.length === 0) {
    throw new TypeError("publishGeneration: modelVersion required");
  }
  if (bm25 == null && hnsw == null) {
    throw new TypeError("publishGeneration: at least one of {bm25, hnsw} required");
  }
  const { dir, bm25Path, hnswPath, hnswMetaPath } = indexPathsFor(modelVersion);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // S2y — PUBLISHER MUTUAL EXCLUSION. Every publication runs under the S2
  // flush lease: pre-S2y an out-of-band publisher (daemon rebuild, reembed
  // script) racing the lease-holding debounced flush interleaved member
  // writes/checksums/manifest activations, so the loser bound checksums over
  // the winner's bytes or clobbered the winner's members under the winner's
  // manifest (index-manifest T13). The flush path already holds the lease
  // and passes opts._leaseHeld; everyone else acquires here with a bounded
  // wait and fails CLOSED with a structured, catchable error — the daemon's
  // maybeRunBm25Rebuild surfaces it as its rebuild_failed envelope and
  // retries next tick.
  const leaseHeld = opts != null && opts._leaseHeld === true;
  let publishLease = null;
  if (!leaseHeld) {
    publishLease = _acquirePublishLease(
      dir,
      opts != null && typeof opts === "object" ? opts.leaseWaitMs : undefined,
    );
    if (publishLease == null) {
      const err = new Error(
        `publishGeneration: flush lease busy for ${modelVersion} (${dir}); ` +
          `skipping publication (retry when the current writer finishes)`,
      );
      err.code = "index_flush_lease_busy";
      throw err;
    }
  }
  try {
    return _publishGenerationLocked(modelVersion, { bm25, hnsw }, opts, {
      dir,
      bm25Path,
      hnswPath,
      hnswMetaPath,
    });
  } finally {
    if (publishLease != null) releaseLease(publishLease);
  }
}

// The pre-S2y publishGeneration pipeline, byte-identical in behavior —
// factored out so the lease wrapper above stays readable. CALLER HOLDS THE
// FLUSH LEASE (either its own bounded-wait acquisition or the flush path's).
function _publishGenerationLocked(modelVersion, { bm25, hnsw }, opts, paths) {
  const { dir, bm25Path, hnswPath, hnswMetaPath } = paths;

  // S3 — resolve the generation lineage BEFORE touching the fixed paths. A
  // pre-manifest tree is adopted as generation 0 first, so the legacy state
  // becomes the retained fallback of the generation about to be written. A
  // corrupt-but-present manifest fails CLOSED (structured throw) — never a
  // silent gen-0 re-adoption.
  const mread = readActiveManifest(dir);
  if (mread.error != null) {
    const err = new Error(
      `publishGeneration: index manifest for ${modelVersion} exists but is ` +
        `unreadable (${JSON.stringify(mread.error)}); refusing to publish over it`,
    );
    err.code = mread.error.code ?? "index_manifest_unreadable";
    err.detail = mread.error;
    throw err;
  }
  let active = mread.manifest;
  if (
    active == null &&
    (existsSync(bm25Path) || existsSync(hnswPath) || existsSync(hnswMetaPath))
  ) {
    const adoptCursor = readAppliedCursor(dir);
    const adopted = adoptGeneration0(dir, {
      wal_cursor: {
        applied_seq: adoptCursor.applied_seq,
        applied_offset: adoptCursor.applied_offset,
      },
    });
    if (adopted.error != null) {
      console.error(
        `index-cache: generation-0 adoption failed for ${modelVersion}: ` +
          `${JSON.stringify(adopted.error)}`,
      );
    }
    active = adopted.manifest;
  }

  // Retain the outgoing generation (hardlink snapshot — writers only ever
  // replace members via rename, so the linked inodes are immutable) as the
  // ONE fallback the new manifest will name. Retention failure degrades to
  // carrying the older fallback: it never blocks the save and never unlinks
  // anything.
  let previous = null;
  if (active != null) {
    const kept = retainActiveGeneration(dir, active);
    if (kept.members != null) {
      previous = {
        generation: active.generation,
        wal_cursor: active.wal_cursor ?? null,
        members: kept.members,
      };
    } else {
      console.error(
        `index-cache: generation retention failed for ${modelVersion}: ` +
          `${JSON.stringify(kept.error)}; carrying the prior fallback`,
      );
      previous = active.previous ?? null;
    }
  }

  // Member writes — ONLY the members this publication rewrites, strictly
  // AFTER retention. WU-RR1: the default bm25 writer streams the v2
  // line-delimited format (JSON.stringify on the whole blob crashes with
  // ERR_STRING_TOO_LONG at ~1.4M facts); loadIndices auto-detects v2.
  let savedHnsw = null;
  if (bm25 != null) {
    if (typeof bm25 === "function") bm25(bm25Path);
    else _writeBm25V2(bm25Path, bm25);
  }
  if (hnsw != null) {
    savedHnsw = typeof hnsw === "function" ? hnsw(hnswPath) : hnsw.save(hnswPath);
  }

  // S3 — bind the members into ONE checksummed generation manifest and
  // publish it with a single atomic rename (activateManifest: tmp + file
  // fsync + rename + best-effort dir fsync). Until it lands, readers keep
  // verifying against the OLD manifest and fall back to the retention
  // snapshots, so a crash anywhere in this function leaves either the old or
  // the new generation fully active — never a mix. Rewritten members are
  // re-checksummed; untouched members carry their recorded checksums forward.
  const activeMembers =
    active != null && active.members != null ? active.members : {};
  // The just-written hnsw's save artifact ({backend, dims, format,
  // embedding_model_version, metaPath}); a linear-scan save carries
  // metaPath:null, a native save the sidecar path. Hoisted here (was computed
  // below) so the hnsw_meta binding can consult saved.metaPath.
  const saved =
    savedHnsw != null && typeof savedHnsw === "object" ? savedHnsw : null;

  // FIX (I5 content-identity carry) — the retention snapshot of each carried
  // member is a hardlink of the recorded bytes ONLY when retention just
  // snapshotted the CURRENT active generation (previous.generation ===
  // active.generation). _carryMember uses it for an O(1) dev+ino identity
  // check before trusting the recorded digest; a degraded/older snapshot (or
  // none) forces a re-checksum of the on-disk bytes.
  const freshSnapshotMembers =
    previous != null &&
    active != null &&
    previous.generation === active.generation &&
    previous.members != null
      ? previous.members
      : null;
  const snapshotPathFor = (key) => {
    const m =
      freshSnapshotMembers != null ? (freshSnapshotMembers[key] ?? null) : null;
    return m != null ? join(dir, m.file) : null;
  };

  const members = {
    bm25:
      bm25 != null
        ? checksumMemberFile(dir, "bm25.json")
        : _carryMember(
            dir,
            activeMembers.bm25 ?? null,
            "bm25.json",
            snapshotPathFor("bm25"),
          ),
    hnsw:
      hnsw != null
        ? checksumMemberFile(dir, "hnsw.bin")
        : _carryMember(
            dir,
            activeMembers.hnsw ?? null,
            "hnsw.bin",
            snapshotPathFor("hnsw"),
          ),
    // FIX (F1) — when this publication REWROTE the hnsw member, bind the meta
    // from the save ARTIFACT, not a stale on-disk sidecar probe. A linear-scan
    // save (metaPath null) binds no meta and removes any stale native sidecar
    // so HnswIndex.load does not misroute to it (see _bindFreshHnswMeta). A
    // carried (hnsw-untouched) publish threads the meta snapshot like the
    // other members.
    hnsw_meta:
      hnsw != null
        ? _bindFreshHnswMeta(dir, hnswMetaPath, saved)
        : _carryMember(
            dir,
            activeMembers.hnsw_meta ?? null,
            "hnsw.bin.meta.json",
            snapshotPathFor("hnsw_meta"),
          ),
  };
  // S2y — HNSW bin/meta COHERENCE gate (extended, F1, to the FRESH-SAVE path).
  // A member bound here — whether freshly written OR an UNRECORDED stray
  // carried from the fixed paths — was never vouched for by the active
  // manifest on THIS runtime; an incoherent bin/meta pair produces a
  // generation that verifies on every cold load and then throws inside
  // HnswIndex.load — permanent fallback churn. Refuse it with a structured
  // breadcrumb and publish without the member (bootstrap-empty semantics); the
  // writer that owns those bytes republishes them through this same seam. A
  // native fresh save (opaque bin + native meta) stays coherent; a linear
  // fresh save (bin=linear, no meta after the sidecar unlink above) is
  // coherent on a linear runtime. RECORDED carries skip the probe — their
  // lineage was vouched for at their own publication.
  const _hnswNeedsCoherenceProbe =
    members.hnsw != null &&
    (hnsw != null || (activeMembers.hnsw ?? null) == null);
  if (_hnswNeedsCoherenceProbe) {
    const coherence = _carriedHnswPairCoherent(dir);
    if (!coherence.ok) {
      console.error(
        `index-cache: ${JSON.stringify({
          code: "index_hnsw_member_incoherent",
          model_version: modelVersion,
          reason: coherence.reason,
        })}; publishing without the hnsw member`,
      );
      members.hnsw = null;
      members.hnsw_meta = null;
    }
  }
  const hnswObj = hnsw != null && typeof hnsw !== "function" ? hnsw : null;
  const cursorIn = opts != null && typeof opts === "object" ? opts.walCursor : null;
  let walCursor;
  if (
    cursorIn != null &&
    Number.isSafeInteger(cursorIn.applied_seq) &&
    Number.isSafeInteger(cursorIn.applied_offset)
  ) {
    // The flush path's CAPTURED cursor, embedded verbatim.
    walCursor = {
      applied_seq: cursorIn.applied_seq,
      applied_offset: cursorIn.applied_offset,
    };
  } else {
    const cursor = readAppliedCursor(dir);
    walCursor = {
      applied_seq: cursor.applied_seq,
      applied_offset: cursor.applied_offset,
    };
  }
  const generation = active != null ? active.generation + 1 : 0;
  // Model metadata: the just-written hnsw's artifact binding wins; a partial
  // (hnsw-untouched) publish carries the active manifest's metadata forward.
  const manifest = buildManifest({
    generation,
    embedding_model_version:
      (saved != null ? saved.embedding_model_version : null) ??
      (hnswObj != null ? hnswObj.embedding_model_version : null) ??
      (active != null ? active.embedding_model_version : null) ??
      modelVersion,
    dims:
      (saved != null ? saved.dims : null) ??
      (hnswObj != null ? hnswObj.dims : null) ??
      (active != null ? active.dims : null) ??
      null,
    hnsw_backend:
      (saved != null ? saved.backend : null) ??
      (hnsw == null && active != null ? active.hnsw_backend : null),
    hnsw_format:
      (saved != null ? saved.format : null) ??
      (hnsw == null && active != null ? active.hnsw_format : null),
    wal_cursor: walCursor,
    members,
    previous,
  });
  activateManifest(dir, manifest);

  // GC retention files of generations older than the one retained fallback.
  // Never removes a generation the just-activated manifest names (its own or
  // previous) — the fallback is never unlinked.
  const gc = gcGenerations(dir, manifest);
  if (gc.error != null) {
    console.error(
      `index-cache: generation GC failed for ${modelVersion}: ` +
        `${JSON.stringify(gc.error)}`,
    );
  }

  // Cache coherence: any cached entry now refers to a superseded generation.
  // Drop it — the next loadIndices does a fresh manifest-gated load (its
  // fingerprint would miss anyway; this just keeps the map honest).
  // saveIndices re-seeds the entry with the live objects right after.
  _indexCache.delete(modelVersion);

  return { manifest, dir };
}

// ---------------------------------------------------------------------------
// W2-debounced-index-persistence — scheduleSaveIndices + pending-adds journal
// ---------------------------------------------------------------------------
// The promote path used to call saveIndices() once PER FACT, rewriting the
// full multi-GB hnsw.bin + bm25.json every time (~TB/day of SSD writes at
// ~1,800 facts/day). In-memory adds are cheap; only persistence needs
// batching. scheduleSaveIndices appends a tiny self-contained journal line
// per fact and flushes the real saveIndices when a budget is crossed.
//
// W3-wal-budget-flush — the flush TRIGGER is no longer the W2 count-OR-age
// pair (64 adds / 5 min — still ~288 full multi-GB rewrites/day, ~544GB/day
// of SSD writes at the measured cadence). Since S2 the WAL is the durable
// record of every add and S3's manifest gates publication, so the full save
// exists ONLY to bound cold-load replay cost. The trigger is therefore a
// replay-cost budget over the UNRETIRED WAL (records / bytes / staleness of
// the oldest pending add); INDEX_SAVE_BATCH / INDEX_SAVE_MAX_AGE_S survive
// as legacy/test overrides honored only when explicitly set. flushIndicesNow
// still forces an immediate save. See _indexSaveWalRecords() below.
//
// DURABILITY ORDERING (PRE-VERIFIED): all three updateIndicesForFact call
// sites in distill-promote-fact.js (MCP handler, operator put,
// promoteSourceRow) run strictly AFTER appendFactRow, which
// writeSync+fsyncSync's the fact row — carrying features.embedding_4096 /
// embedding_mrl_768 INLINE — and fsyncs the ledger directory. The durable
// pre-index record is therefore the LEDGER ROW itself, not any vectors
// sidecar (no such sidecar exists: the native hnsw path persists only
// hnsw.bin + .meta.json id-maps; raw vectors are not on disk separately).
// Because this module is forbidden from reading ledgers/memory.jsonl, the
// journal must be SELF-CONTAINED: each record carries the full add record
// {fact_id, ts, bm25_entry, vector} (~40-80 KB/line — four orders of
// magnitude below the full-index rewrite it replaces).
//
// S2: the journal is now the sequenced, crc-framed index-wal.jsonl WAL
// (index-wal.js). A successful flush RETIRES records by advancing the
// applied cursor (advanceAppliedCursor) — never by truncating the file —
// so a record appended by another process mid-save can never be erased.
// Exactly one process flushes at a time (acquireFlushLease); contention
// skips the flush and the WAL keeps the data. The fully-applied WAL is
// compacted (emptied, seq NEVER reset) under the same lease.

// LEGACY/TEST OVERRIDES — honored ONLY when the env var is explicitly set
// (W3). Pre-W3 these defaulted to 64 adds / 5 min and were the PRIMARY
// trigger; the replay-cost budgets below are the policy now. Tests (and any
// operator override) that set INDEX_SAVE_BATCH / INDEX_SAVE_MAX_AGE_S still
// get exactly the old count/age behavior; unset, they contribute nothing.
function _indexSaveBatch() {
  const raw = process.env.INDEX_SAVE_BATCH;
  if (raw == null || raw === "") return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function _indexSaveMaxAgeMs() {
  const raw = process.env.INDEX_SAVE_MAX_AGE_S;
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n * 1000 : null;
}

// W3 — replay-cost budgets over the UNRETIRED WAL. The full save exists only
// to bound cold-load replay cost (the WAL is the durable record of every
// add; the S3 manifest gates publication), so the trigger measures exactly
// that cost: how many records / bytes a cold load would replay, and how
// stale the oldest unretired add is. Replay cost ≈ record-count × measured
// per-add cost (native hnswlib add ~1-3ms at 4096 dims → the full
// 8192-record budget replays in ~8-25s worst case; the measured
// ~1,800-fact/day cadence under the 6h staleness budget keeps the typical
// WAL near ~450 records, ~0.5-1.5s of replay).
function _indexSaveWalRecords() {
  const n = Number.parseInt(process.env.INDEX_SAVE_WAL_RECORDS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 8192;
}

function _indexSaveWalBytes() {
  const n = Number.parseInt(process.env.INDEX_SAVE_WAL_BYTES ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 64 * 1024 * 1024;
}

function _indexSaveMaxStalenessMs() {
  const n = Number(process.env.INDEX_SAVE_MAX_STALENESS_MS ?? "");
  return Number.isFinite(n) && n > 0 ? n : 6 * 3600 * 1000;
}

// Quiet-period timer budget: the legacy age override when explicitly set,
// else the W3 staleness budget.
function _indexSaveQuietMs() {
  return _indexSaveMaxAgeMs() ?? _indexSaveMaxStalenessMs();
}

// S2: the O_APPEND|O_CREAT|O_NOFOLLOW + full-write-loop + fsync fd discipline
// that lived here (_appendJournalLine) moved into index-wal.js
// appendWalRecord, which additionally frames each line with a monotonic seq
// and a crc32 over the exact rec bytes.

// Per-modelVersion pending state. timer is always unref()'d so a pending
// flush never keeps the process alive; bm25/hnsw hold the LATEST index refs
// so the timer callback can flush without a further schedule call.
const _pendingSaves = new Map(); // modelVersion -> {count, oldestTs, timer, bm25, hnsw}

/**
 * Force the debounced index flush for `modelVersion` to happen NOW.
 *
 * Exported for callers that need read-your-writes against the ON-DISK index
 * (tests asserting index materialization, and the manual rebuild scripts).
 * Production promote paths must keep using scheduleSaveIndices — calling this
 * per fact reinstates the ~2.79 TB/day full-index rewrite W2 exists to remove.
 *
 * @returns {boolean} true iff a pending batch was flushed to disk.
 */
export function flushIndicesNow(modelVersion) {
  return _flushPendingSaves(modelVersion, "forced");
}

// `trigger` labels WHY this flush fired for the full-save telemetry line:
// "forced" (flushIndicesNow), "legacy_batch" (explicit INDEX_SAVE_BATCH),
// "wal_records" / "wal_bytes" (W3 replay-cost budgets), or "staleness"
// (oldest unretired add aged past the budget, including the quiet-period
// timer path). "quarantine" is stamped by the S2d recovery path itself
// (_quarantineAndRecover), never passed in here.
function _flushPendingSaves(modelVersion, trigger = "forced") {
  const pending = _pendingSaves.get(modelVersion);
  if (pending == null) return false;
  if (pending.timer != null) {
    clearTimeout(pending.timer);
    pending.timer = null;
  }
  const { dir, pendingPath } = indexPathsFor(modelVersion);
  // Re-arm the quiet-period timer so a skipped/failed flush retries without
  // waiting for the next promote (W3: on the staleness budget, or the legacy
  // age override when explicitly set — no longer a hardcoded 5 min).
  const rearm = () => {
    pending.timer = setTimeout(
      () => _flushPendingSaves(modelVersion, "staleness"),
      _indexSaveQuietMs(),
    );
    if (typeof pending.timer.unref === "function") pending.timer.unref();
  };

  // (a) S2 single-writer lease: exactly one process persists indices at a
  // time. Contention SKIPS this flush — the WAL keeps every record; the
  // current lease holder (or a later retry here) retires them.
  const lease = acquireFlushLease(dir);
  if (lease == null) {
    console.error(
      `index-cache: flush lease busy for ${modelVersion}; WAL kept, will retry`,
    );
    rearm();
    return false;
  }
  try {
    // (b0) S2b/S3 — stale-base check under the lease, on GENERATION
    // identity. If the active manifest's generation no longer matches the
    // base identity stamped at schedule time, ANOTHER process persisted a
    // newer generation since our pending indices were loaded; saving
    // pending.bm25/hnsw would clobber its adds with our stale base (T8).
    // Reload the on-disk base instead — loadIndices fresh-loads on the
    // identity miss and replays the WAL tail, and our own scheduled adds are
    // in that WAL, so nothing of ours is lost. The stat fingerprints remain
    // as belt-and-suspenders for out-of-band fixed-path writers that bypass
    // the manifest (e.g. the offline bm25 rebuild script).
    const { bm25Path, hnswPath } = indexPathsFor(modelVersion);
    let target = { bm25: pending.bm25, hnsw: pending.hnsw };
    const activeManifest = readActiveManifest(dir).manifest;
    const activeGen = activeManifest != null ? activeManifest.generation : null;
    if (
      (pending.baseGeneration ?? null) !== activeGen ||
      pending.baseBm25Fp !== statFingerprint(bm25Path) ||
      pending.baseHnswFp !== statFingerprint(hnswPath)
    ) {
      console.error(
        `index-cache: stale base detected for ${modelVersion} (another process ` +
          `persisted a newer generation); reloading base + replaying WAL before save`,
      );
      const reloaded = loadIndices(modelVersion);
      target = { bm25: reloaded.bm25, hnsw: reloaded.hnsw };
    }

    // (b) Replay every unretired WAL record into the indices about to be
    // saved (idempotent — our own scheduled adds are already in memory; adds
    // from OTHER processes are the ones this replay actually contributes).
    // Capture the cursor BEFORE saving: a record appended while saveIndices
    // runs stays unretired and survives into the next flush.
    const cursor = readAppliedCursor(dir);
    if (cursor.error != null) {
      console.error(
        `index-cache: applied-cursor error for ${modelVersion}: ${cursor.error}; refusing to flush`,
      );
      rearm();
      return false;
    }
    const tail = readWalTail(
      dir,
      { afterSeq: cursor.applied_seq, fromOffset: cursor.applied_offset },
      (rec) => _applyAddRecord(rec, target.bm25, target.hnsw),
    );
    if (tail.error != null) {
      // Fail-closed: never persist-and-retire PAST corruption. The first
      // sighting refuses and rearms (a transient torn read heals itself);
      // a PERSISTENT error switches to the S2d quarantine path below —
      // otherwise the flush refuses forever, the WAL grows unboundedly, and
      // every promote keeps paying for it.
      //
      // S2y: "persistent" is now judged across PROCESS LIFETIMES. The first
      // sighting persists a strike sidecar (index-wal.corrupt-strike.json);
      // a second sighting of the SAME error string — whether the second
      // attempt happens in this process (pending.walTailErrors) or in a
      // fresh per-session MCP spawn (the persisted strike) — quarantines.
      // Pre-S2y the counter was process-memory only, and short-lived
      // sessions never reached attempt #2 (T15).
      pending.walTailErrors = (pending.walTailErrors ?? 0) + 1;
      const strike = readCorruptStrike(dir);
      const persistent =
        pending.walTailErrors >= 2 ||
        (strike != null && strike.error === tail.error);
      if (!persistent) {
        recordCorruptStrike(dir, tail.error);
        console.error(
          `index-cache: WAL tail error for ${modelVersion}: ${tail.error}; refusing to flush (strike recorded)`,
        );
        rearm();
        return false;
      }
      return _quarantineAndRecover(modelVersion, {
        dir,
        lease,
        pending,
        target,
        tail,
        rearm,
        // REG — the pre-flush applied cursor, so the quarantine path's
        // full-save telemetry can report the records it retired.
        cursor,
      });
    }
    pending.walTailErrors = 0;
    clearCorruptStrike(dir); // a clean tail read invalidates any stale strike
    const captured = {
      applied_seq: tail.lastSeq,
      applied_offset: tail.lastOffset,
    };

    // (c) Persist under the lease. S3: saveIndices writes the members and
    // then ACTIVATES the new generation's manifest (single atomic rename,
    // after file+dir fsync) with the CAPTURED cursor embedded verbatim —
    // i.e. activation happens INSIDE this lease, strictly after the member
    // writes and strictly before the cursor-advance retirement in (d). A
    // crash between activation and (d) leaves already-applied records
    // unretired; replay is idempotent (same window as pre-S3).
    // LOCK-DISCIPLINE NOTE (S2.2, documented deviation 2 in index-wal.js's
    // header): this single heartbeat is the only one during the synchronous
    // save — measured production-scale save cost is ~0.8s against the 60s
    // ttl (the S3 checksum read-back adds seconds, still ~10x inside it),
    // and the alive flusher pid blocks single-host stale reclaim.
    heartbeatLease(lease);
    try {
      // S2y: _leaseHeld — this flush already owns the S2 flush lease, so
      // publishGeneration must not try to re-acquire it (mutual exclusion is
      // in force; a self-wait would always time out).
      saveIndices(
        modelVersion,
        { bm25: target.bm25, hnsw: target.hnsw },
        { walCursor: captured, _leaseHeld: true },
      );
    } catch (e) {
      // Flush failure: keep the WAL INTACT and the cursor UNMOVED (the WAL is
      // the crash-repair record; loadIndices replays it) and leave a
      // breadcrumb.
      console.error(
        `index-cache: debounced index flush failed for ${modelVersion}: ${e.message}; ` +
          `WAL kept in ${dir}`,
      );
      rearm();
      return false;
    }

    // (c1) W3 telemetry — exactly ONE structured stderr line per full save
    // so FINAL can table index writes/day before-vs-after (emitter shared
    // with the S2d quarantine path; see _emitFullSaveTelemetry).
    _emitFullSaveTelemetry(
      dir,
      modelVersion,
      trigger,
      captured.applied_seq - cursor.applied_seq,
    );

    // (d) RETIRE by advancing the applied cursor — this replaces the pre-S2
    // truncate-to-empty, which erased other processes' mid-save appends. A
    // crash (or cursor-write failure) between saveIndices and this advance
    // leaves already-applied records unretired; replay is idempotent.
    const adv = advanceAppliedCursor(dir, captured);
    if (adv.error != null) {
      console.error(
        `index-cache: failed to advance applied cursor for ${modelVersion}: ${adv.error}`,
      );
    }

    // (e) Legacy migration: a non-empty pending-adds.jsonl was replayed into
    // the in-memory indices at load time, so its records are in the base just
    // saved. Rename it out of the way — NEVER unlink data.
    try {
      if (existsSync(pendingPath) && statSync(pendingPath).size > 0) {
        renameSync(pendingPath, `${pendingPath}.migrated-${Date.now()}`);
      }
    } catch (e) {
      console.error(
        `index-cache: legacy pending-adds migration failed for ${modelVersion}: ${e.message}`,
      );
    }

    // (f) Compact the fully-applied WAL (empties the file; seq NEVER resets).
    // Skipped automatically when a mid-save append left an unretired tail.
    let compacted = false;
    if (adv.error == null) {
      const c = compactWal(dir);
      if (c.error != null) {
        console.error(
          `index-cache: WAL compaction failed for ${modelVersion}: ${c.error}`,
        );
      }
      compacted = c.compacted === true;
    }

    // Keep the cache entry's warm-hit WAL marker current (saveIndices just
    // reset the entry without one; without this, the next warm hit would do
    // one harmless idempotent full-WAL replay to re-learn it). S2y: include
    // the marker's inode identity — compaction swapped the WAL's inode, and
    // a stale walIno would force the next warm hit through the (safe but
    // costlier) identity-unproven verification path.
    const entry = _indexCache.get(modelVersion);
    if (entry != null && entry.bm25 === target.bm25) {
      entry.walSeq = captured.applied_seq;
      entry.walOffset = compacted ? 0 : captured.applied_offset;
      try {
        entry.walIno = statSync(join(dir, WAL_FILE)).ino;
      } catch {
        entry.walIno = null; // no WAL on disk right now
      }
    }

    _pendingSaves.delete(modelVersion);
    return true;
  } finally {
    // (g) Always release the lease — a failed flush must not wedge the
    // single-writer slot until stale reclaim.
    releaseLease(lease);
  }
}

// W3 telemetry — exactly ONE structured stderr line per full save so FINAL
// can table index writes/day before-vs-after. stderr, not telemetry.js
// annotate(): annotate is request-path-only (it needs the withTelemetry
// dispatch context) and this flush also runs on unref()'d timers outside any
// dispatch. Member sizes come from the generation manifest the save just
// activated (checksumMemberFile recorded the written bytes). Telemetry must
// never fail a flush that already persisted. REG (memperf): factored out of
// the main flush path so the S2d quarantine recovery emits the same line
// with trigger "quarantine" — pre-REG that full save was telemetry-silent.
function _emitFullSaveTelemetry(dir, modelVersion, trigger, walRecordsRetired) {
  try {
    const published = readActiveManifest(dir).manifest;
    const memberBytes = {};
    for (const key of ["bm25", "hnsw", "hnsw_meta"]) {
      const member = published != null ? published.members[key] : null;
      if (member != null && Number.isSafeInteger(member.size)) {
        memberBytes[key] = member.size;
      }
    }
    console.error(
      JSON.stringify({
        event: "index_full_save",
        ts: new Date().toISOString(),
        model_version: modelVersion,
        trigger,
        generation: published != null ? published.generation : null,
        wal_records_retired: walRecordsRetired,
        bytes_written: Object.values(memberBytes).reduce((s, b) => s + b, 0),
        member_bytes: memberBytes,
      }),
    );
  } catch (e) {
    console.error(
      `index-cache: full-save telemetry emit failed for ${modelVersion}: ${e.message}`,
    );
  }
}

// _quarantineAndRecover — S2d corruption operability. Runs UNDER the flush
// lease when a readWalTail crc/seq-gap error PERSISTED across two flush
// attempts. Pre-S2d the flush refused forever: the WAL grew unboundedly,
// every warm load re-scanned to the corruption, and the only signal was
// stderr. Recovery, fail-closed at every step:
//   1. persist the indices WITH the valid WAL prefix already replayed into
//      them (readWalTail delivered everything BEFORE the bad record);
//   2. retire up to — never past — the last GOOD record (the module contract
//      explicitly blesses "retire up to, but never past, the corruption");
//   3. quarantineWal: rename the WAL to index-wal.jsonl.corrupt-<epoch-ms>
//      (bytes retained, NEVER unlinked — records past the corruption stay
//      operator-recoverable in the quarantined file), reset the active
//      stream from the applied cursor, and emit the structured note that
//      memory_health surfaces as an `index_wal_quarantined:` health_note.
function _quarantineAndRecover(modelVersion, { dir, lease, pending, target, tail, rearm, cursor }) {
  console.error(
    `index-cache: PERSISTENT WAL corruption for ${modelVersion}: ${tail.error}; ` +
      `quarantining (valid prefix persisted + retired first)`,
  );
  heartbeatLease(lease);
  try {
    // S3: same generation-manifest publication as the main flush path — the
    // captured cursor here is the last GOOD record's position (retire up to,
    // never past, the corruption).
    saveIndices(
      modelVersion,
      { bm25: target.bm25, hnsw: target.hnsw },
      {
        walCursor: { applied_seq: tail.lastSeq, applied_offset: tail.lastOffset },
        // S2y: the flush lease is held by this very recovery path.
        _leaseHeld: true,
      },
    );
  } catch (e) {
    console.error(
      `index-cache: pre-quarantine flush failed for ${modelVersion}: ${e.message}; ` +
        `WAL kept in ${dir}`,
    );
    rearm();
    return false;
  }
  const adv = advanceAppliedCursor(dir, {
    applied_seq: tail.lastSeq,
    applied_offset: tail.lastOffset,
  });
  if (adv.error != null) {
    console.error(
      `index-cache: pre-quarantine cursor advance failed for ${modelVersion}: ${adv.error}`,
    );
    rearm();
    return false;
  }
  const q = quarantineWal(dir, { reason: tail.error });
  if (q.error != null) {
    // The save + retire above still happened; the corrupt WAL remains and the
    // next flush attempt re-enters this path to retry the quarantine.
    console.error(
      `index-cache: WAL quarantine failed for ${modelVersion}: ${q.error}`,
    );
    rearm();
    return false;
  }
  // REG (memperf, W3 followup) — the quarantine recovery IS a full save
  // (valid prefix persisted + retired above); pre-REG it was the ONE flush
  // path with no index_full_save line, so FINAL's writes/day table silently
  // undercounted every corruption recovery. Same emitter as the main path,
  // trigger "quarantine". Retired count = last GOOD record minus the
  // pre-flush cursor (never past the corruption).
  _emitFullSaveTelemetry(
    dir,
    modelVersion,
    "quarantine",
    cursor != null && Number.isSafeInteger(cursor.applied_seq)
      ? tail.lastSeq - cursor.applied_seq
      : null,
  );
  // Fresh (empty) WAL: point the warm-hit marker at it and clear any
  // corruption pin so warm loads resume absorbing new appends. walIno is
  // null — the quarantine renamed the WAL away and no fresh one exists yet
  // (the next append recreates it); _absorbWalTail re-learns the identity
  // on its next scan.
  const entry = _indexCache.get(modelVersion);
  if (entry != null && entry.bm25 === target.bm25) {
    entry.walSeq = tail.lastSeq;
    entry.walOffset = 0;
    entry.walIno = null;
    entry.walCorruptIno = null;
  }
  _pendingSaves.delete(modelVersion);
  return true;
}

/**
 * scheduleSaveIndices — debounced replacement for the per-fact saveIndices
 * call on the promote path. Journal-append is synchronous + fsync'd (tiny);
 * the expensive full-index persist is batched.
 *
 * @param {string} modelVersion — per-version index discipline key.
 * @param {{bm25, hnsw}} indices — the LIVE in-memory indices (already contain
 *   the add; loadIndices keeps serving them ahead-of-disk via the fingerprint
 *   cache refresh in saveIndices).
 * @param {{factId: string, bm25Entry: object, vector: number[]}} add — the
 *   self-contained journal record for this fact.
 * @returns {{flushed: boolean, pending: number}}
 */
export function scheduleSaveIndices(modelVersion, { bm25, hnsw } = {}, add = {}) {
  if (typeof modelVersion !== "string" || modelVersion.length === 0) {
    throw new TypeError("scheduleSaveIndices: modelVersion required");
  }
  if (!bm25 || !hnsw) {
    throw new TypeError(
      "scheduleSaveIndices: both bm25 and hnsw must be provided",
    );
  }
  const { factId, bm25Entry, vector } = add;
  if (typeof factId !== "string" || factId.length === 0) {
    throw new TypeError("scheduleSaveIndices: add.factId required");
  }
  const { dir } = indexPathsFor(modelVersion);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // WAL first — if this throws, the caller's existing index-failure
  // handling fires (fact row is already durable; backfill repairs later).
  // S2: appendWalRecord is the sequenced, crc-framed successor of the old
  // pending-adds journal append; same self-contained payload, same
  // fsync-per-record durability.
  // W3: capture the returned {seq, offset} — the append position against the
  // applied cursor IS the unretired-WAL span the flush trigger budgets on.
  const wal = appendWalRecord(dir, {
    fact_id: factId,
    // REG — through Date.now() (not the zero-arg Date constructor) so the
    // record ts shares ONE clock with the staleness math that now reads it
    // back (_walHeadTsMs); identical in production, and clock-injection
    // tests (P7) patch exactly Date.now.
    ts: new Date(Date.now()).toISOString(),
    bm25_entry: bm25Entry != null && typeof bm25Entry === "object" ? bm25Entry : null,
    vector: Array.isArray(vector) ? vector : null,
  });

  let pending = _pendingSaves.get(modelVersion);
  if (pending == null) {
    // REG (memperf, W3 followup) — CROSS-PROCESS STALENESS SEED. oldestTs
    // previously seeded from Date.now(), so records left unretired by
    // ANOTHER process (or a previous lifetime of this one — e.g. a crashed
    // flusher) never aged the staleness trigger: every fresh spawn restarted
    // the clock and a stale WAL could stay unflushed indefinitely. Seed from
    // the WAL HEAD record's ts (the oldest unretired add — our own append
    // above when the WAL was empty, so the no-foreign-records case is
    // unchanged). Bounded cost: one cursor read + the first WAL record, once
    // per pending-entry creation (i.e. once per flush interval per process);
    // any head-read degradation falls back to the old now-seed.
    pending = {
      count: 0,
      oldestTs: _walHeadTsMs(dir) ?? Date.now(),
      timer: null,
      bm25,
      hnsw,
    };
    _pendingSaves.set(modelVersion, pending);
  }
  pending.count += 1;
  // Latest refs win — the timer callback must flush the indices that actually
  // contain the journaled adds.
  pending.bm25 = bm25;
  pending.hnsw = hnsw;
  // S2b/S3 — stamp the BASE IDENTITY these pending indices were loaded
  // against, now bound to the GENERATION identity of the S3 manifest. The
  // flush lease serializes writers but cannot see that a base saved by
  // ANOTHER process superseded ours between our load and our flush; without
  // this stamp the flush would write a stale base over it (last-writer-wins
  // clobber, T8). When the indices are the cache entry's objects the stamp is
  // the generation + fingerprints recorded at their load (warm hits never
  // refresh them, so they stay the true base identity); otherwise
  // (rebuild/backfill-style callers that hand in fresh objects) read the
  // active manifest's generation and the on-disk fingerprints now. The stat
  // fingerprints remain as belt-and-suspenders for out-of-band fixed-path
  // writers that bypass the manifest.
  const cacheEntry = _indexCache.get(modelVersion);
  if (cacheEntry != null && cacheEntry.bm25 === bm25 && cacheEntry.hnsw === hnsw) {
    pending.baseGeneration = cacheEntry.generation ?? null;
    pending.baseBm25Fp = cacheEntry.bm25Fp;
    pending.baseHnswFp = cacheEntry.hnswFp;
  } else {
    const { bm25Path, hnswPath } = indexPathsFor(modelVersion);
    const m = readActiveManifest(dir).manifest;
    pending.baseGeneration = m != null ? m.generation : null;
    pending.baseBm25Fp = statFingerprint(bm25Path);
    pending.baseHnswFp = statFingerprint(hnswPath);
  }

  // Lazy trigger check on every schedule call — W3: the flush fires on a
  // REPLAY-COST budget over the unretired WAL (record depth / byte span /
  // staleness of the oldest pending add), not the W2 64-count. The legacy
  // count trigger applies ONLY when INDEX_SAVE_BATCH is explicitly set.
  const span = _walSpan(dir, pending, wal);
  const legacyBatch = _indexSaveBatch();
  const stalenessMs = _indexSaveQuietMs();
  const ageMs = Date.now() - pending.oldestTs;
  let trigger = null;
  if (legacyBatch != null && pending.count >= legacyBatch) {
    trigger = "legacy_batch";
  } else if (span.depth > _indexSaveWalRecords()) {
    trigger = "wal_records";
  } else if (span.bytes > _indexSaveWalBytes()) {
    trigger = "wal_bytes";
  } else if (ageMs >= stalenessMs) {
    trigger = "staleness";
  }
  if (trigger != null) {
    const flushed = _flushPendingSaves(modelVersion, trigger);
    return { flushed, pending: flushed ? 0 : pending.count };
  }
  // ...plus an unref()'d timer so a quiet period still flushes once the
  // oldest pending add ages past the staleness budget.
  if (pending.timer == null) {
    pending.timer = setTimeout(
      () => _flushPendingSaves(modelVersion, "staleness"),
      Math.max(stalenessMs - ageMs, 1),
    );
    if (typeof pending.timer.unref === "function") pending.timer.unref();
  }
  return { flushed: false, pending: pending.count };
}

// _walHeadTsMs — epoch-ms ts of the OLDEST unretired WAL record, or null
// when there is none / it carries no parseable ts / the cursor or scan
// errors (callers fall back to the now-seed; the flush path itself keeps
// failing closed on real errors). Uses readWalTail's documented
// caller-callback-throws-propagate contract to abort after the FIRST
// record — one bounded chunk read, never a full unretired-span replay.
const _WAL_HEAD_STOP = new Error("_walHeadTsMs: head record read");
function _walHeadTsMs(dir) {
  const cursor = readAppliedCursor(dir);
  if (cursor.error != null) return null;
  let headTs = null;
  try {
    readWalTail(
      dir,
      { afterSeq: cursor.applied_seq, fromOffset: cursor.applied_offset },
      (rec) => {
        const t =
          rec != null && typeof rec.ts === "string" ? Date.parse(rec.ts) : NaN;
        if (Number.isFinite(t)) headTs = t;
        throw _WAL_HEAD_STOP;
      },
    );
  } catch (e) {
    if (e !== _WAL_HEAD_STOP) return null;
  }
  return headTs;
}

// _walSpan — depth (records) and bytes of the UNRETIRED WAL span: the
// just-returned append position {seq, offset} minus the applied cursor. The
// cursor is cached on the pending entry — a successful flush DELETES the
// entry (so the next schedule re-reads the advanced cursor) and compaction
// runs inside that same flush; every false-return of _flushPendingSaves
// happens before the cursor advances, so a surviving entry's cache is still
// exact. If ANOTHER process advanced/compacted meanwhile the cached cursor
// yields a negative span — refresh once and clamp (worst case is one early
// flush, never a lost record: the flush path re-reads the cursor itself). A
// cursor READ error degrades to this process's own pending count (the flush
// path fails closed on a real cursor error).
function _walSpan(dir, pending, wal) {
  if (pending.walCursor == null) {
    const c = readAppliedCursor(dir);
    pending.walCursor = c.error == null ? c : null;
  }
  if (pending.walCursor != null) {
    let depth = wal.seq - pending.walCursor.applied_seq;
    let bytes = wal.offset - pending.walCursor.applied_offset;
    if (depth >= 0 && bytes >= 0) return { depth, bytes };
    const c = readAppliedCursor(dir);
    pending.walCursor = c.error == null ? c : null;
    if (pending.walCursor != null) {
      depth = Math.max(wal.seq - pending.walCursor.applied_seq, 0);
      bytes = Math.max(wal.offset - pending.walCursor.applied_offset, 0);
      return { depth, bytes };
    }
  }
  return { depth: pending.count, bytes: 0 };
}

// ---------------------------------------------------------------------------
// Ledger reader (module-scope cache)
// ---------------------------------------------------------------------------
let _ledgerCache = null; // { fp, byId: Map, all: Array }

// WU-RR2b — back-compat SAFETY cap. loadLedger() materializes EVERY ledger row
// into byId + all. On the live 1.45M-fact / 1.78 GB ledger that is both an OOM
// hazard and pointless work for the recall hot path (which now uses the scoped
// loadLedgerRowsByIds below). Production recall no longer calls loadLedger();
// it survives only for legacy/test callers. If such a caller hits the live
// ledger we cap the build at LOAD_LEDGER_SAFETY_CAP rows, log a warning, and
// return what we have rather than risk an OOM kill.
const LOAD_LEDGER_SAFETY_CAP = 50000;

/**
 * loadLedger — LEGACY full-ledger reader. Returns { fp, byId: Map, all: Array }.
 *
 * WU-RR2b: rewritten to STREAM (streamLedgerLines) instead of
 * readFileSync(path, "utf8"). The old read crashed with ERR_STRING_TOO_LONG
 * once memory.jsonl crossed Node's ~512 MiB MAX_STRING_LENGTH. Streaming makes
 * it crash-safe; the LOAD_LEDGER_SAFETY_CAP guard makes it OOM-safe.
 *
 * Production recall (recall.js step e) now uses loadLedgerRowsByIds() with the
 * bounded fused candidate set — it never builds the full byId map. Keep this
 * export only for back-compat with legacy/test callers.
 */
export function loadLedger() {
  const path = memoryLedgerPath();
  const fp = statFingerprint(path);
  if (_ledgerCache != null && _ledgerCache.fp === fp) {
    return _ledgerCache;
  }

  const byId = new Map();
  const all = [];
  if (!existsSync(path)) {
    _ledgerCache = { fp, byId, all };
    return _ledgerCache;
  }

  let capped = false;
  try {
    streamLedgerLines(path, (row) => {
      if (capped) return;
      if (row == null || typeof row !== "object") return;
      if (typeof row.id !== "string") return;
      byId.set(row.id, row);
      all.push(row);
      if (all.length >= LOAD_LEDGER_SAFETY_CAP) {
        capped = true;
      }
    });
  } catch (e) {
    // streamLedgerLines is internally defensive and should not throw, but a
    // caller-visible bug (e.g. OOM mid-build) is logged rather than propagated
    // so recall degrades gracefully on whatever rows were materialized.
    console.error(`index-cache: failed to stream ${path}: ${e.message}`);
  }
  if (capped) {
    console.warn(
      `index-cache: loadLedger hit the ${LOAD_LEDGER_SAFETY_CAP}-row safety cap on ${path}; ` +
        `returning a partial ledger. Production recall should use loadLedgerRowsByIds.`,
    );
  }
  _ledgerCache = { fp, byId, all };
  return _ledgerCache;
}

/**
 * loadLedgerRowsByIds — WU-RR2b SCOPED ledger reader for the recall hot path,
 * WU-recall-latency-fix accelerated.
 *
 * Resolves ONLY the rows whose id is in `idSet` (the bounded fused candidate set
 * — typically hundreds). The returned byId Map has at most idSet.size entries.
 *
 * FAST PATH (WU-recall-latency-fix): seekLedgerRowsByIds(path, idSet) seeks each
 * wanted row by BYTE OFFSET via a module-cached, tail-merged offset index. The
 * measured profile showed the OLD per-query full stream of the 1.8 GB ledger was
 * 83% of recall latency (~5.2s); the offset seek turns that into K random-access
 * reads (K = idSet.size) after a ONE-TIME (or sidecar-loaded) index build.
 *
 * Per-id VERIFICATION inside the seek: every seeked row's parsed id MUST equal
 * the wanted id, so a stale/wrong offset (append-only invariant violated) yields
 * a MISS for that id, never a wrong row. Any id the offset index could not
 * resolve (a miss) is then back-filled by a scoped stream over JUST the missing
 * ids — so the result is byte-for-byte identical to the legacy full-stream
 * resolver regardless of index freshness. If the index could not be built at all
 * (indexed=false), we fall back wholesale to the legacy scoped stream.
 *
 * KIND POLICY (unchanged): the recall candidate set legitimately contains
 * kind:"reconstructed" rows and the legacy loadLedger().byId resolved ANY row
 * with a string id. Both the seek path and the stream fallback resolve any row
 * by id (no kind filter) — matching the old loadLedger semantics, scoped.
 *
 * Latest-write-wins: a later row for the same id overwrites the earlier one
 * (matches loadLedger's Map.set semantics; the offset index records the LAST
 * offset for each id, and the stream fallback Map.sets in file order).
 *
 * @param {Set<string>|string[]} idSet — memory_ids to resolve.
 * @returns {{ byId: Map<string, object>, fp: string }}
 */
export function loadLedgerRowsByIds(idSet) {
  const path = memoryLedgerPath();
  const fp = statFingerprint(path);
  const wanted =
    idSet instanceof Set
      ? idSet
      : new Set(Array.isArray(idSet) ? idSet : []);
  const byId = new Map();
  if (wanted.size === 0 || !existsSync(path)) {
    return { byId, fp };
  }

  // FAST PATH — byte-offset seek via the tail-merged offset index.
  let missing = null; // ids the offset index could not resolve
  try {
    const seeked = seekLedgerRowsByIds(path, wanted);
    if (seeked && seeked.indexed === true && seeked.byId instanceof Map) {
      for (const [id, row] of seeked.byId) byId.set(id, row);
      if (seeked.misses > 0) {
        missing = new Set();
        for (const id of wanted) {
          if (!byId.has(id)) missing.add(id);
        }
      }
    } else {
      // index unavailable -> resolve everything via the stream fallback.
      missing = wanted;
    }
  } catch (e) {
    console.error(
      `index-cache: offset-seek failed for ${path}: ${e.message}; ` +
        `falling back to scoped stream`,
    );
    missing = wanted;
  }

  // FALLBACK / BACK-FILL — scoped stream over JUST the ids the seek missed.
  // This preserves exact back-compat: any id that the offset index could not
  // resolve (cold/absent index, or a verification miss) is resolved by the same
  // streaming semantics the legacy resolver used. On the common path `missing`
  // is null (every wanted id seeked cleanly) and this block is skipped.
  if (missing != null && missing.size > 0) {
    let remaining = missing.size;
    try {
      streamLedgerLines(path, (row) => {
        if (remaining === 0) return;
        if (row == null || typeof row !== "object") return;
        if (typeof row.id !== "string") return;
        if (!missing.has(row.id)) return;
        // Latest-write-wins; only decrement on first sight of each missing id.
        if (!byId.has(row.id)) remaining -= 1;
        byId.set(row.id, row);
      });
    } catch (e) {
      console.error(
        `index-cache: failed to scoped-stream ${path}: ${e.message}`,
      );
    }
  }

  return { byId, fp };
}

// ---------------------------------------------------------------------------
// IndexEntry builder
// ---------------------------------------------------------------------------
// Build the IndexEntry shape (per kb/phase3-v0-contracts.md § 1) from a raw
// ledger row, plus the derivation-excise-set for the orphan flag computation
// (the excise set is already a Set<memory_id> in applyHardGates; we leave
// derivation_orphan computation to hard-gates and only carry derived_from
// on the entry so the gate can introspect it).
export function rowToIndexEntry(row, modelVersion) {
  if (row == null || typeof row !== "object") return null;
  const features = row.features || {};
  // Phase 1 facts may NOT have an embedding yet. v0 leaves embedding_768 +
  // embedding_3072 null and downstream scoring treats null embeddings as
  // s_emb=0. Backfill (scripts/backfill-embeddings.mjs, separate concern)
  // will populate these going forward.
  const embedding_768 = Array.isArray(features.embedding_768)
    ? features.embedding_768
    : null;
  const embedding_3072 = Array.isArray(features.embedding_3072)
    ? features.embedding_3072
    : null;
  // WU1-local-embedder-client-and-dim4096 — full Qwen3 4096-dim embedding.
  // New facts embedded by the local backend carry features.embedding_4096
  // (full, no MRL slice) + features.embedding_model_version =
  // "qwen3-embedding-8b-fp16". The s_emb cosine compares ONLY same-model
  // vectors (cross-model -> 0; they live in different geometries), so we
  // carry the 4096 vector alongside the legacy 3072 one. Recall stays sound
  // during/after migration: a candidate that has embedding_4096 uses it; an
  // old Gemini fact that has only embedding_3072 falls back to that.
  const embedding_4096 = Array.isArray(features.embedding_4096)
    ? features.embedding_4096
    : null;
  // consent_basis is now stored on source_refs (per the Phase 1 H7 fix in
  // distill-promote-fact.js). Roll it up: use the first source_ref's basis,
  // default first_party.
  let consent_basis = "first_party";
  if (Array.isArray(row.source_refs) && row.source_refs.length > 0) {
    const sr0 = row.source_refs[0];
    if (sr0 && typeof sr0.consent_basis === "string") {
      consent_basis = sr0.consent_basis;
    }
  }
  // WORKUNIT A-promote-projection — entities are stamped as OBJECTS
  // {canonical_id, kind, surface, ...} by the cascade (entity-extractor +
  // gazetteer + row-parties). The legacy `String(e)` projection coerced an
  // object to "[object object]"; project the canonical_id (lowercased) instead,
  // IDENTICAL to the incremental-add path in distill-promote-fact.js
  // updateIndicesForFact so a from-scratch rebuild matches an incremental add.
  // Tolerates the legacy string-shaped entry (canonical_id-as-string) too.
  const entities = Array.isArray(features.entities)
    ? features.entities
        .map((e) => {
          if (e && typeof e === "object" && typeof e.canonical_id === "string") {
            return e.canonical_id.toLowerCase();
          }
          if (typeof e === "string") return e.toLowerCase();
          return "";
        })
        .filter((e) => e !== "")
    : [];
  // Wave 6 — propagate the cascade-stamped synthesis features through to the
  // multi-feature scorer. salience is already consumed via candidate.features
  // by _resolveSalienceForScore (R25 path); episodicity is consumed via the
  // 2-arg synthesisEpisodicityMatch path added in W6 to multi-feature-score.
  // We forward the entire features block so future axes (e.g. corroboration
  // count) require no further plumbing edits at this seam.
  const featuresOut = features && typeof features === "object" ? features : null;
  return {
    memory_id: row.id,
    kind: typeof row.kind === "string" ? row.kind : "fact",
    content: typeof row.content === "string" ? row.content : "",
    embedding_768,
    embedding_3072,
    embedding_4096,
    embedding_model_version: typeof features.embedding_model_version === "string"
      ? features.embedding_model_version
      : modelVersion,
    ts: typeof row.created_at === "string" ? row.created_at : "",
    entities,
    // WORKUNIT A-promote-projection — project the structured valence object to
    // the scalar ∈ [-1,+1] the multi-feature scorer's valenceCompat consumes.
    // factValenceScalar tolerates the legacy numeric form AND the new object
    // form; this rebuild path and updateIndicesForFact share the SAME projection.
    valence: factValenceScalar(features.valence),
    derived_from: Array.isArray(row.derived_from) ? row.derived_from : [],
    consent_basis,
    features: featuresOut,
  };
}

/**
 * evictModelIndices(modelVersion) → {evicted, hadPending}
 *
 * PRODUCTION-SAFE eviction of a SINGLE model version's cached BM25 + HNSW
 * refs from the module-global cache (frees the multi-GB in-memory indices for
 * GC). Distinct from the test-only _resetCaches, which clears EVERY model's
 * cache plus the offset/projection caches and hooks.
 *
 * Safe to call from a live daemon:
 *   - Never touches on-disk indices / manifest / WAL bytes.
 *   - No-op on a cold model (nothing cached, no pending save).
 *   - Never throws.
 *   - No durable data loss (I8 WAL is source of truth): if a debounced save
 *     was pending, its timer is cancelled and the pending record dropped from
 *     memory, but the un-flushed adds already live in the durable WAL and
 *     replay on the next cold load. The debounce re-arms on the next recall.
 *     Eviction NEVER forces a synchronous multi-GB flush (I7).
 */
export function evictModelIndices(modelVersion) {
  if (typeof modelVersion !== "string" || modelVersion.length === 0) {
    throw new TypeError("evictModelIndices: modelVersion required");
  }
  let hadPending = false;
  const pending = _pendingSaves.get(modelVersion);
  if (pending != null) {
    hadPending = true;
    if (pending.timer != null) clearTimeout(pending.timer);
    _pendingSaves.delete(modelVersion);
  }
  const evicted = _indexCache.delete(modelVersion);
  return { evicted, hadPending };
}

// Additive cache-introspection seam (used by the eviction test): does the
// module-global cache currently hold an entry for this model version?
export function _indexCacheHas(modelVersion) {
  return _indexCache.has(modelVersion);
}

// Test-only escape hatch — used by hermetic E2E tests (Phase 5) to ensure
// caches do not bleed across test files even within one node process.
//
// WU-recall-latency-fix: also clears the byte-offset index cache. A hermetic
// test that rewrites its fixture ledger in place (NOT append-only) would
// otherwise leave a stale offset index whose verification step would (safely)
// miss; clearing it forces a clean rebuild on the next resolve.
export function _resetCaches() {
  _indexCache.clear();
  _ledgerCache = null;
  // S3 fix cycle 2 — clear the reader-race interleaving hook so a hook from
  // one test can never fire inside another test's load.
  _afterVerifyHook = null;
  _resetOffsetCaches();
  // WU-incrementalize-recall-recomputes — clear the shared derivation-graph /
  // entity-index / feature-backfill append-aware projection cache too.
  _resetAppendAwareProjectionCache();
  // W2-debounced-index-persistence — cancel pending flush timers and drop the
  // pending-save state so hermetic tests stay isolated (a timer from one test
  // must never fire a flush into another test's temp tree).
  for (const pending of _pendingSaves.values()) {
    if (pending.timer != null) clearTimeout(pending.timer);
  }
  _pendingSaves.clear();
}
