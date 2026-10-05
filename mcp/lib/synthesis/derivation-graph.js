// derivation-graph.js — substrate-tier derivation graph
// (F-SYN-SUBSTRATE-DERIVATION-GRAPH).
//
// Foundation spec: docs/specs/synthesis/derivation-propagation.md
// Authoritative for the three derivation-bearing kinds:
//   - fact          (derivation edges via source_refs[].corroboration_event_id)
//   - policy        (edges via targets[])
//   - reconstructed (edges via derived_from[])
//
// This module is the SINGLE SOURCE OF TRUTH for derivation edges across the
// system (cross-tier invariant S8). Both directions of the graph are exposed:
//
//   - `reverseAdj: Map<parent_id, Set<child_id>>` — used by the EXCISE
//     channel. Starting from an excised root, BFS visits descendants
//     (parent → child) so the recall-time hard-gates can mark reconstructed
//     descendants as orphaned / partially_orphaned.
//
//   - `forwardAdj: Map<child_id, Set<parent_id>>` — used by the ENGAGEMENT
//     channel. Starting from an engaged reconstructed event, BFS walks UP
//     to parent events (child → parent) so reinforcement flows toward the
//     evidence floor.
//
//   - `kindOf: Map<memory_id, "fact" | "policy" | "recall" | "reconstructed">`
//     — populated for every emitter-row scanned. Engagement BFS uses this to
//     STOP-AT-EVIDENCE (terminate at the first non-reconstructed ancestor).
//
// Cache discipline (mirrors entity-index.js / time-index.js):
//   - The cache key is the ledger's `mtimeMs` at build time.
//   - On `loadOrRebuildDerivationGraph` we statSync the ledger; if the
//     recorded `ledger_mtime_ms` diverges (or the cache is missing / corrupt)
//     we rebuild from the ledger and (when a cachePath is provided) persist
//     the freshly-built graph atomically.
//
// Determinism: the rebuild is a pure function of the ledger bytes. Same
// ledger → same graph (Map insertion order matches ledger order; Set
// membership is exact). Cycles in the graph are a ledger-integrity bug;
// `detectCycles` surfaces them for the validator at append time. BFS
// walkers defend against cycles via a `visited` Set so the hot path
// terminates gracefully even if a cycle slips past the validator.

import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Buffer } from "node:buffer";
import { streamLedgerLines } from "./_ledger-stream.js";
// WU-incrementalize-recall-recomputes — the daemon appends to memory.jsonl
// every tick, so the disk-cache key (ledger_mtime_ms) misses on every
// production query and loadOrRebuildDerivationGraph fell through to a full
// 1.82 GB streamLedgerLines scan (~5.2 s warm). The shared append-aware
// tail-merge replays ONLY the appended bytes into the cached graph.
import {
  appendAwareLedgerProjection,
} from "./append-aware-ledger-projection.js";
// Q4 (memperf) — the COLD-START seed now rides the S1 checkpoint primitive
// (newline-safe pinned EOF + sampled prefix-identity witness) instead of the
// exact-mtime equality that the appending daemon defeated on every fresh
// process (full 2.2 GB re-stream + a 45.7 MB SYNCHRONOUS cache write awaited
// inline on the recall path). The persisted payload embeds a serialized
// checkpoint; on load the cached prefix is re-verified fail-closed and ONLY
// the appended delta rows fold through the SAME applyRow reducer.
import {
  captureCheckpoint,
  deserializeCheckpoint,
  emptyCheckpoint,
  readAppended,
  serializeCheckpoint,
} from "./ledger-checkpoint.js";

// Cache-partition id for the shared append-aware projection helper.
const DERIVATION_GRAPH_PROJECTION_NS = "derivation-graph";

/** Maximum BFS depth for any propagation channel.
 *  Pinned by F-SYN-FOUNDATION-derivation-propagation § 3.1. */
export const PROPAGATION_DEPTH_MAX = 3;

/** Per-hop multiplicative damping factor for propagation. */
export const DECAY_PER_HOP = 0.5;

/** Propagation-stop floor; BFS halts when propagated_strength falls below. */
export const THRESHOLD_FLOOR = 0.01;

/** Cache schema version. Bump on any structural change.
 *
 *  v2 (R2/WI1, memperf): the v1 payload was ONE monolithic JSON document
 *  (45.7 MB in production) whose cold load cost 920-1135 ms — measured
 *  2026-07-16 on the live cache: JSON.parse 522 ms + Map/Set rebuild 582 ms.
 *  v2 is a SECTIONED BINARY file that loads in ~440 ms (same box, same data):
 *
 *    line 1   small JSON header {schema_version:"v2", ledger_mtime_ms,
 *             built_at, checkpoint, counts, bytes} + "\n"
 *    then     8-byte-aligned sections:
 *               ids       utf8, every distinct id once, joined by "\n"
 *               kinds     utf8, distinct kind strings, joined by "\n"
 *               kindIdx   Uint32[ids]     (0xFFFFFFFF = id has no kind)
 *               fwdKeys   Uint32[fwd_keys]  forwardAdj key id-indices
 *               fwdDeg    Uint32[fwd_keys]  per-key Set size
 *               fwdMem    Uint32[fwd_edges] concatenated member id-indices
 *               revKeys / revDeg / revMem   same for reverseAdj
 *
 *  The measured alternatives lost: NDJSON rows re-parsed per line (848 ms) and
 *  the v1 monolith (1135 ms); the binary's floor is the irreducible 1.5M-entry
 *  kindOf Map population. The embedded checkpoint stays the S1 validity
 *  carrier (verified fail-closed BEFORE the sections are materialized).
 *  LEGACY v1 payloads (a single JSON line, no "\n" in the whole file) are
 *  never reinterpreted: one full rebuild migrates them to v2. */
export const DERIVATION_GRAPH_SCHEMA_VERSION = "v2";

// Q4 write policy: on an incremental cold seed (cache + delta fold), re-persist
// the multi-MB cache ONLY when the un-persisted delta since the cached
// checkpoint exceeds this cap (or the witness re-baselined, which must land on
// disk). Bounds the delta a fresh process re-folds without rewriting a 45.7 MB
// file on every process start. A full rebuild always persists.
const PERSIST_DELTA_BYTES_CAP = 16 * 1024 * 1024; // 16 MiB, frozen

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Return the ledger's mtimeMs, or null if the ledger does not exist. */
function statLedgerMtime(ledgerPath) {
  try {
    return statSync(ledgerPath).mtimeMs;
  } catch {
    return null;
  }
}

/** Mutually update forward + reverse adjacency. */
function addEdge(forwardAdj, reverseAdj, childId, parentId) {
  if (typeof childId !== "string" || childId.length === 0) return;
  if (typeof parentId !== "string" || parentId.length === 0) return;
  // Self-loops are silently dropped — a node cannot derive from itself per the
  // append-only ordering invariant.
  if (childId === parentId) return;

  let parents = forwardAdj.get(childId);
  if (parents === undefined) {
    parents = new Set();
    forwardAdj.set(childId, parents);
  }
  parents.add(parentId);

  let children = reverseAdj.get(parentId);
  if (children === undefined) {
    children = new Set();
    reverseAdj.set(parentId, children);
  }
  children.add(childId);
}

/** Apply a single ledger row to the in-progress graph. */
function applyRow(forwardAdj, reverseAdj, kindOf, row) {
  if (row == null || typeof row !== "object") return;
  const id = row.id;
  if (typeof id !== "string" || id.length === 0) return;

  // Tag the kind on every emitter-row we see. Unknown kinds are still
  // recorded so the engagement BFS can STOP-AT-EVIDENCE at any non-
  // reconstructed ancestor (whatever its kind happens to be).
  if (typeof row.kind === "string" && row.kind.length > 0) {
    kindOf.set(id, row.kind);
  }

  // reconstructed events: every entry of `derived_from[]` becomes a parent.
  if (row.kind === "reconstructed" && Array.isArray(row.derived_from)) {
    for (const parentId of row.derived_from) {
      try {
        addEdge(forwardAdj, reverseAdj, id, parentId);
      } catch {
        // Defensive: malformed parent entries are silently skipped — they
        // are the writer's problem, not the index's.
      }
    }
  }

  // fact events: source_refs[].corroboration_event_id contributes derivation
  // edges (this is the fact-tier "fact_source_corroboration" edge kind from
  // the F-SYN-SUBSTRATE-DERIVATION-GRAPH node's edge taxonomy).
  if (row.kind === "fact" && Array.isArray(row.source_refs)) {
    for (const ref of row.source_refs) {
      if (ref == null || typeof ref !== "object") continue;
      const parentId = ref.corroboration_event_id;
      if (typeof parentId !== "string" || parentId.length === 0) continue;
      try {
        addEdge(forwardAdj, reverseAdj, id, parentId);
      } catch {
        // see above
      }
    }
  }

  // policy events: targets[] contributes derivation edges (e.g., a corroboration
  // policy points at the fact it corroborates; an exclude policy at the target
  // it excludes).
  if (row.kind === "policy" && Array.isArray(row.targets)) {
    for (const targetId of row.targets) {
      if (typeof targetId !== "string" || targetId.length === 0) continue;
      try {
        addEdge(forwardAdj, reverseAdj, id, targetId);
      } catch {
        // see above
      }
    }
  }
}

/**
 * Parse the ledger file line-by-line, populating the three maps in one pass.
 * Missing ledger → empty maps (cold-start case).
 */
function streamLedgerIntoGraph(ledgerPath) {
  const forwardAdj = new Map();
  const reverseAdj = new Map();
  const kindOf = new Map();
  if (!existsSync(ledgerPath)) return { forwardAdj, reverseAdj, kindOf };
  // RR2c — stream row-by-row. The previous readFileSync(ledgerPath,"utf8")
  // threw ERR_STRING_TOO_LONG (Node MAX_STRING_LENGTH ~512MB) on the 1.78GB
  // live ledger, which silently disabled the recall-time derivation orphan
  // gate. We keep only the small derived adjacency maps, never the full
  // ledger string. (The function's name always promised streaming; now it
  // delivers it.)
  streamLedgerLines(ledgerPath, (row) => {
    try {
      applyRow(forwardAdj, reverseAdj, kindOf, row);
    } catch {
      // Defensive: a single malformed row never aborts the scan.
    }
  });
  return { forwardAdj, reverseAdj, kindOf };
}

// ---------------------------------------------------------------------------
// v2 sectioned-binary cache codec (R2/WI1). See the format doc on
// DERIVATION_GRAPH_SCHEMA_VERSION above.
// ---------------------------------------------------------------------------

const V2_NO_KIND = 0xffffffff; // kindIdx sentinel: this id carries no kind
const V2_ALIGN = 8;
function _v2Pad(n) {
  return (V2_ALIGN - (n % V2_ALIGN)) % V2_ALIGN;
}

/**
 * Pack the three maps + header fields into the v2 binary layout. Returns an
 * array of Buffers (write them in order — concat is the caller's choice).
 * Throws TypeError if any id/kind contains "\n" (it would corrupt the string
 * table); callers treat a pack failure as "cache not written" — correct, slow
 * next cold load — never a corrupt file.
 */
function _packGraphCacheV2({ forwardAdj, reverseAdj, kindOf, ledger_mtime_ms, built_at, checkpoint }) {
  const idIdx = new Map();
  const ids = [];
  const intern = (id) => {
    let i = idIdx.get(id);
    if (i === undefined) {
      if (id.indexOf("\n") !== -1) {
        throw new TypeError("derivation-graph v2 pack: id contains a newline");
      }
      i = ids.length;
      ids.push(id);
      idIdx.set(id, i);
    }
    return i;
  };
  const kinds = [];
  const kindIdxOf = new Map();
  const internKind = (k) => {
    let i = kindIdxOf.get(k);
    if (i === undefined) {
      if (k.indexOf("\n") !== -1) {
        throw new TypeError("derivation-graph v2 pack: kind contains a newline");
      }
      i = kinds.length;
      kinds.push(k);
      kindIdxOf.set(k, i);
    }
    return i;
  };
  // Intern in a deterministic order: kindOf keys, then each adjacency's keys
  // and members in Map/Set iteration order (pure function of the maps).
  for (const id of kindOf.keys()) intern(id);
  for (const [k, v] of forwardAdj) {
    intern(k);
    for (const m of v) intern(m);
  }
  for (const [k, v] of reverseAdj) {
    intern(k);
    for (const m of v) intern(m);
  }

  const kindIdx = new Uint32Array(ids.length).fill(V2_NO_KIND);
  for (const [id, k] of kindOf) {
    if (typeof k === "string" && k.length > 0) kindIdx[idIdx.get(id)] = internKind(k);
  }

  const packAdj = (adj) => {
    const keys = new Uint32Array(adj.size);
    const deg = new Uint32Array(adj.size);
    let edges = 0;
    for (const v of adj.values()) edges += v.size;
    const members = new Uint32Array(edges);
    let ki = 0;
    let mi = 0;
    for (const [k, v] of adj) {
      keys[ki] = idIdx.get(k);
      deg[ki] = v.size;
      ki += 1;
      for (const m of v) members[mi++] = idIdx.get(m);
    }
    return { keys, deg, members };
  };
  const f = packAdj(forwardAdj);
  const r = packAdj(reverseAdj);

  const idsBuf = Buffer.from(ids.join("\n"), "utf8");
  const kindsBuf = Buffer.from(kinds.join("\n"), "utf8");
  const header = {
    schema_version: DERIVATION_GRAPH_SCHEMA_VERSION,
    ledger_mtime_ms: typeof ledger_mtime_ms === "number" ? ledger_mtime_ms : 0,
    built_at: typeof built_at === "string" ? built_at : new Date().toISOString(),
    checkpoint: checkpoint != null ? serializeCheckpoint(checkpoint) : null,
    counts: {
      ids: ids.length,
      kinds: kinds.length,
      fwd_keys: f.keys.length,
      fwd_edges: f.members.length,
      rev_keys: r.keys.length,
      rev_edges: r.members.length,
    },
    bytes: { ids: idsBuf.length, kinds: kindsBuf.length },
  };
  const parts = [Buffer.from(JSON.stringify(header) + "\n", "utf8")];
  let off = parts[0].length;
  const push = (b) => {
    const p = _v2Pad(off);
    if (p) {
      parts.push(Buffer.alloc(p));
      off += p;
    }
    parts.push(b);
    off += b.length;
  };
  push(idsBuf);
  push(kindsBuf);
  for (const arr of [kindIdx, f.keys, f.deg, f.members, r.keys, r.deg, r.members]) {
    push(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
  }
  return parts;
}

/**
 * Parse ONLY the v2 header line off a cache buffer. Returns
 * { header, bodyOffset } or null when the buffer is not a well-formed v2
 * payload (legacy v1 monoliths have no "\n" anywhere — they land here as null
 * and migrate via full rebuild; a corrupt header likewise fails closed).
 */
function _parseGraphCacheHeaderV2(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  const nl = buf.indexOf(0x0a);
  if (nl <= 0) return null; // legacy v1 monolith (single JSON line) or empty
  let header;
  try {
    header = JSON.parse(buf.toString("utf8", 0, nl));
  } catch {
    return null;
  }
  if (header == null || header.schema_version !== DERIVATION_GRAPH_SCHEMA_VERSION) return null;
  const c = header.counts;
  const b = header.bytes;
  const nn = (x) => Number.isSafeInteger(x) && x >= 0;
  if (
    c == null ||
    b == null ||
    !nn(c.ids) ||
    !nn(c.kinds) ||
    !nn(c.fwd_keys) ||
    !nn(c.fwd_edges) ||
    !nn(c.rev_keys) ||
    !nn(c.rev_edges) ||
    !nn(b.ids) ||
    !nn(b.kinds)
  ) {
    return null;
  }
  return { header, bodyOffset: nl + 1 };
}

/**
 * Materialize the three Maps from a validated v2 buffer. Returns
 * { forwardAdj, reverseAdj, kindOf } or null on any structural violation
 * (short file, index out of range) — fail closed, the caller full-rebuilds.
 * Called ONLY AFTER the embedded checkpoint has re-verified against the
 * ledger, so a doomed load never pays the ~440 ms Map build.
 */
function _materializeGraphCacheV2(buf, header, bodyOffset) {
  try {
    const { counts, bytes } = header;
    let off = bodyOffset + _v2Pad(bodyOffset);
    const takeUtf8 = (nBytes, count) => {
      if (off + nBytes > buf.length) return null;
      const arr = count > 0 ? buf.toString("utf8", off, off + nBytes).split("\n") : [];
      off += nBytes;
      off += _v2Pad(off);
      return arr;
    };
    const ids = takeUtf8(bytes.ids, counts.ids);
    const kinds = takeUtf8(bytes.kinds, counts.kinds);
    if (ids == null || kinds == null) return null;
    if (ids.length !== counts.ids || kinds.length !== counts.kinds) return null;
    const takeU32 = (n) => {
      const nBytes = n * 4;
      if (off + nBytes > buf.length) return null;
      const byteOff = buf.byteOffset + off;
      const arr =
        byteOff % 4 === 0
          ? new Uint32Array(buf.buffer, byteOff, n)
          : new Uint32Array(buf.buffer.slice(byteOff, byteOff + nBytes));
      off += nBytes;
      off += _v2Pad(off);
      return arr;
    };
    const kindIdx = takeU32(counts.ids);
    const fKeys = takeU32(counts.fwd_keys);
    const fDeg = takeU32(counts.fwd_keys);
    const fMem = takeU32(counts.fwd_edges);
    const rKeys = takeU32(counts.rev_keys);
    const rDeg = takeU32(counts.rev_keys);
    const rMem = takeU32(counts.rev_edges);
    if (!kindIdx || !fKeys || !fDeg || !fMem || !rKeys || !rDeg || !rMem) return null;

    const kindOf = new Map();
    for (let i = 0; i < kindIdx.length; i++) {
      const k = kindIdx[i];
      if (k === V2_NO_KIND) continue;
      if (k >= kinds.length) return null;
      kindOf.set(ids[i], kinds[k]);
    }
    const unpackAdj = (keys, deg, mem) => {
      const map = new Map();
      let mi = 0;
      for (let i = 0; i < keys.length; i++) {
        if (keys[i] >= ids.length) return null;
        const set = new Set();
        const d = deg[i];
        if (mi + d > mem.length) return null;
        for (let j = 0; j < d; j++) {
          const m = mem[mi++];
          if (m >= ids.length) return null;
          set.add(ids[m]);
        }
        map.set(ids[keys[i]], set);
      }
      // Every member must be consumed — a mismatch is a corrupt payload.
      return mi === mem.length ? map : null;
    };
    const forwardAdj = unpackAdj(fKeys, fDeg, fMem);
    const reverseAdj = unpackAdj(rKeys, rDeg, rMem);
    if (forwardAdj == null || reverseAdj == null) return null;
    return { forwardAdj, reverseAdj, kindOf };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Q4 — checkpoint fold + persist scheduling internals.
// ---------------------------------------------------------------------------

/**
 * Fold exactly the terminated ledger rows in [fromCp.eof, toCp.eof) into the
 * three maps via the SAME applyRow reducer the full scan uses (semantic
 * identity by construction). Returns { rows, error } where `error` is
 * readAppended's fail-closed error string or null.
 */
function _foldGraphRows(ledgerPath, fromCp, toCp, forwardAdj, reverseAdj, kindOf) {
  let rows = 0;
  const res = readAppended(ledgerPath, fromCp, toCp, (text) => {
    rows += 1;
    try {
      applyRow(forwardAdj, reverseAdj, kindOf, JSON.parse(text));
    } catch {
      // A single malformed row never aborts the fold (streamLedgerLines
      // parity).
    }
  });
  return { rows, error: res.error };
}

// Last cold-seed outcome, observable by the incremental regression test
// (delta-only-parse gate must be falsifiable, not inferred from wall time).
let _lastColdSeedStats = null;

/** Test-only: { mode, rows_folded } of the most recent cold seed. */
export function __peekColdSeedStatsForTests() {
  return _lastColdSeedStats;
}

// In-flight best-effort cache persists (fire-and-forget off the recall
// critical path). Tracked so tests and the latency prebuild can await them.
const _pendingGraphPersists = new Set();

/** Await every in-flight scheduled graph-cache persist (tests + scripts). */
export async function _awaitPendingGraphCachePersists() {
  while (_pendingGraphPersists.size > 0) {
    await Promise.all([..._pendingGraphPersists]);
  }
}

/**
 * Schedule a best-effort, post-response cache persist. NEVER awaited on the
 * recall path; all errors swallowed (the in-memory graph stays valid). The
 * maps are serialized when the task runs; a grow tail-merge that lands rows
 * beyond `checkpoint.eof` in the meantime only OVER-covers the persisted
 * state, which is safe for this projection: every fold step is idempotent
 * (addEdge is Set.add; kindOf is same-value Map.set), so re-folding those
 * rows on the next cold load reproduces the identical graph.
 */
function _scheduleGraphPersist(graph, cachePath) {
  const p = new Promise((resolve) => setImmediate(resolve))
    .then(() => persistGraphCache(graph, cachePath))
    .catch(() => {
      // Best-effort: a persist failure must never surface on the recall path.
    })
    .finally(() => {
      _pendingGraphPersists.delete(p);
    });
  _pendingGraphPersists.add(p);
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Rebuild the derivation graph from the ledger. Optionally persist the result
 * to the cache file at `cachePath`.
 *
 * PIN-FIRST (Q4): the checkpoint is captured BEFORE any read and the fold
 * covers exactly [0, checkpoint.eof) — a torn trailing line is never applied
 * and never certified (it folds once its "\n" lands). If the checkpoint fold
 * fails mid-read (shrink/rewrite race) we fall back to the tolerant legacy
 * stream and persist WITHOUT a checkpoint (correct, slow next cold load).
 *
 * @param {object} opts
 * @param {string} opts.ledgerPath
 * @param {string} [opts.cachePath]
 * @returns {Promise<{
 *   forwardAdj: Map<string, Set<string>>,
 *   reverseAdj: Map<string, Set<string>>,
 *   kindOf: Map<string, string>,
 *   ledger_mtime_ms: number,
 *   built_at: string,
 *   checkpoint: object|null,
 * }>}
 */
export async function rebuildDerivationGraph({ ledgerPath, cachePath } = {}) {
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) {
    throw new TypeError("rebuildDerivationGraph: ledgerPath required");
  }
  let forwardAdj = new Map();
  let reverseAdj = new Map();
  let kindOf = new Map();
  let checkpoint = null;

  const cp = captureCheckpoint(ledgerPath);
  if (cp !== null) {
    const { error } = _foldGraphRows(
      ledgerPath,
      emptyCheckpoint(),
      cp,
      forwardAdj,
      reverseAdj,
      kindOf,
    );
    if (error === null) {
      checkpoint = cp;
    } else {
      // Fold failed between pin and read (shrink / rewrite / io). Fall back
      // to the tolerant legacy stream over the CURRENT file; certify nothing.
      const s = streamLedgerIntoGraph(ledgerPath);
      forwardAdj = s.forwardAdj;
      reverseAdj = s.reverseAdj;
      kindOf = s.kindOf;
    }
  } else if (existsSync(ledgerPath)) {
    // Present-but-unreadable capture: legacy stream (yields empty maps on a
    // truly unreadable file, matching the pre-Q4 behavior).
    const s = streamLedgerIntoGraph(ledgerPath);
    forwardAdj = s.forwardAdj;
    reverseAdj = s.reverseAdj;
    kindOf = s.kindOf;
  }
  const ledger_mtime_ms = statLedgerMtime(ledgerPath) ?? 0;
  const built_at = new Date().toISOString();
  const graph = { forwardAdj, reverseAdj, kindOf, ledger_mtime_ms, built_at, checkpoint };

  if (typeof cachePath === "string" && cachePath.length > 0) {
    try {
      await persistGraphCache(graph, cachePath);
    } catch {
      // Cache write failure is non-fatal — the in-memory graph is still
      // valid. Callers that need the cache observe its absence on disk.
    }
  }
  return graph;
}

/**
 * Load the derivation graph from the cache file if it is consistent with the
 * ledger's current mtime; otherwise rebuild from the ledger.
 *
 * @param {object} opts
 * @param {string} opts.ledgerPath
 * @param {string} [opts.cachePath]
 * @returns {Promise<ReturnType<typeof rebuildDerivationGraph>>}
 */
export async function loadOrRebuildDerivationGraph({ ledgerPath, cachePath } = {}) {
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) {
    throw new TypeError("loadOrRebuildDerivationGraph: ledgerPath required");
  }

  // WU-incrementalize-recall-recomputes — the module-scope append-aware cache
  // is the WARM path: on the common daemon-append case it tail-merges ONLY the
  // appended ledger bytes into the cached graph instead of re-streaming the
  // whole 1.82 GB file. Determinism is preserved: the tail rows are applied via
  // the SAME applyRow merge in ledger order after the cached prefix, so the
  // result is byte-identical to a full rebuild (addEdge is a Set.add; kindOf is
  // latest-wins Map.set). The disk cache remains a COLD-START seed used by the
  // fullRebuild callback below (the first build in a fresh process).
  //
  // `_persistedFromColdRebuild` lets the cold branch hand the freshly-built
  // graph back out so we can (a) attach ledger_mtime_ms/built_at and (b)
  // persist the disk cache exactly once, off the hot grow path.
  let coldRebuiltGraph = null;

  const struct = appendAwareLedgerProjection({
    ledgerPath,
    namespace: DERIVATION_GRAPH_PROJECTION_NS,
    makeEmpty: () => ({
      forwardAdj: new Map(),
      reverseAdj: new Map(),
      kindOf: new Map(),
    }),
    applyParsedRow: (s, row) => {
      applyRow(s.forwardAdj, s.reverseAdj, s.kindOf, row);
    },
    fullRebuild: (lp) => {
      // Cold / shrink / mtime-regression: try the on-disk sidecar first (a
      // fresh process skips the cold full scan), else stream the whole file.
      // FIX CYCLE 2: hand the projection layer the seed's ACTUAL coverage —
      // the pinned checkpoint eof — as resumeOffset, so a row torn at seed
      // time (bytes [cp.eof, st.size)) is re-read by the warm grow once its
      // "\n" lands instead of being permanently skipped. Legacy/degraded
      // seeds (no checkpoint) covered the whole current file via the tolerant
      // stream; they keep the historical raw-size resume (resumeOffset null).
      const seeded = _coldSeedDerivationGraph(lp, cachePath);
      coldRebuiltGraph = seeded;
      return {
        struct: { forwardAdj: seeded.forwardAdj, reverseAdj: seeded.reverseAdj, kindOf: seeded.kindOf },
        resumeOffset:
          seeded.checkpoint != null && Number.isSafeInteger(seeded.checkpoint.eof)
            ? seeded.checkpoint.eof
            : null,
      };
    },
  });

  // Missing-ledger cold-start: appendAwareLedgerProjection invoked fullRebuild
  // (which seeded coldRebuiltGraph) even with no file; honor that shape.
  const currentMtime = statLedgerMtime(ledgerPath);
  if (struct == null) {
    // Defensive: should not happen because fullRebuild always returns a struct.
    return rebuildDerivationGraph({ ledgerPath, cachePath });
  }

  // Preserve the historical return shape: the three Maps PLUS ledger_mtime_ms /
  // built_at. On a warm tail-merge there is no fresh built_at; we derive a
  // stable one tied to the current ledger state.
  const ledger_mtime_ms =
    coldRebuiltGraph != null && typeof coldRebuiltGraph.ledger_mtime_ms === "number"
      ? coldRebuiltGraph.ledger_mtime_ms
      : currentMtime ?? 0;
  const built_at =
    coldRebuiltGraph != null && typeof coldRebuiltGraph.built_at === "string"
      ? coldRebuiltGraph.built_at
      : new Date().toISOString();

  // Q4: persist the disk cache ONLY when the cold seed says so (full rebuild,
  // or a folded delta past the byte cap / witness re-baseline — NEVER on an
  // exact-eof cache hit, and never on a warm tail-merge), and NEVER awaited
  // inline: the old code awaited a 45.7 MB synchronous write on the recall
  // critical path here. The write is scheduled best-effort post-response.
  if (
    coldRebuiltGraph != null &&
    coldRebuiltGraph._needsPersist === true &&
    typeof cachePath === "string" &&
    cachePath.length > 0
  ) {
    _scheduleGraphPersist(
      {
        forwardAdj: struct.forwardAdj,
        reverseAdj: struct.reverseAdj,
        kindOf: struct.kindOf,
        ledger_mtime_ms,
        built_at,
        checkpoint: coldRebuiltGraph.checkpoint ?? null,
      },
      cachePath,
    );
  }

  return {
    forwardAdj: struct.forwardAdj,
    reverseAdj: struct.reverseAdj,
    kindOf: struct.kindOf,
    ledger_mtime_ms,
    built_at,
  };
}

/**
 * Cold-start seed for the derivation graph: prefer a CHECKPOINT-VALIDATED
 * on-disk cache + delta fold (so a fresh process against the live appending
 * ledger skips the cold full scan), else full-rebuild from the ledger.
 * Returns { forwardAdj, reverseAdj, kindOf, ledger_mtime_ms, built_at,
 * checkpoint, _mode, _needsPersist }.
 *
 * Q4 flow (mirrors content-index.js v2):
 *   1. Read + validate the cache payload; deserialize its checkpoint.
 *   2. PIN FIRST: captureCheckpoint({prev: cachedCp}) — the internal
 *      verifyPrefix is the one O(witness) prefix verification per load.
 *      The S1c flags gate soundness: extendedPrev (verbatim witness
 *      extension) or prefixVerified (witness-cap re-baseline; the prefix
 *      verified byte-identical inside the capture call). Anything else —
 *      shrink, rewrite, atomic replacement — is a checkpoint discontinuity:
 *      full rebuild, never a hybrid of cached maps + new-file delta.
 *   3. Exact-eof match serves the cached maps with NO rewrite; otherwise
 *      fold exactly [cachedCp.eof, newCp.eof) through the SAME applyRow
 *      reducer the full scan uses.
 *   4. Legacy payloads (v1 monolithic JSON — with or without a checkpoint —
 *      and any corrupt/short file) are NEVER reinterpreted in place: one full
 *      rebuild migrates them to the v2 sectioned-binary payload.
 *
 * This is invoked by appendAwareLedgerProjection's fullRebuild branch on the
 * cold / shrink / mtime-regression case ONLY — never on the warm append path.
 */
function _coldSeedDerivationGraph(ledgerPath, cachePath) {
  const currentMtime = statLedgerMtime(ledgerPath);
  const finish = (seed) => {
    _lastColdSeedStats = { mode: seed._mode, rows_folded: seed._rowsFolded ?? 0 };
    return seed;
  };
  if (typeof cachePath === "string" && cachePath.length > 0 && existsSync(cachePath)) {
    try {
      const raw = readFileSync(cachePath);
      // v2 sectioned binary ONLY. A legacy v1 monolith (single JSON line, no
      // "\n" byte anywhere in the file) or a corrupt payload parses to null
      // here and migrates via the full rebuild below — never reinterpreted
      // in place.
      const parsedV2 = _parseGraphCacheHeaderV2(raw);
      const cachedCp =
        parsedV2 != null && parsedV2.header.checkpoint != null
          ? deserializeCheckpoint(parsedV2.header.checkpoint)
          : null;
      if (parsedV2 != null && cachedCp !== null) {
        // Guard a degenerate payload: an origin-cursor checkpoint (eof 0)
        // certifies NOTHING, so non-empty cached maps under it would be
        // unverifiable foreign state — fail closed into a full rebuild.
        // (counts.ids === 0 implies all three maps are empty: every adjacency
        // key/member and every kindOf key is an interned id.)
        const cachedLooksEmpty = parsedV2.header.counts.ids === 0;
        if (cachedCp.eof > 0 || cachedLooksEmpty) {
          // PIN FIRST, then read only bytes at/below the pinned eof. The maps
          // are materialized ONLY after the S1c soundness gate passes, so a
          // discontinuity never pays the multi-hundred-ms Map build.
          const newCp = captureCheckpoint(ledgerPath, { prev: cachedCp });
          if (
            newCp !== null &&
            (newCp.extendedPrev === true || newCp.prefixVerified === true)
          ) {
            const maps = _materializeGraphCacheV2(raw, parsedV2.header, parsedV2.bodyOffset);
            if (maps !== null) {
              const { forwardAdj, reverseAdj, kindOf } = maps;
              const builtAt =
                typeof parsedV2.header.built_at === "string"
                  ? parsedV2.header.built_at
                  : new Date().toISOString();
              if (newCp.eof === cachedCp.eof) {
                // Exact hit: zero delta, zero disk writes.
                return finish({
                  forwardAdj,
                  reverseAdj,
                  kindOf,
                  ledger_mtime_ms: currentMtime ?? 0,
                  built_at: builtAt,
                  checkpoint: cachedCp,
                  _mode: "cache-hit-exact",
                  _needsPersist: false,
                  _rowsFolded: 0,
                });
              }
              const { rows, error } = _foldGraphRows(
                ledgerPath,
                cachedCp,
                newCp,
                forwardAdj,
                reverseAdj,
                kindOf,
              );
              if (error === null) {
                const rebaselined = newCp.extendedPrev !== true; // prefixVerified resample
                const deltaBytes = newCp.eof - cachedCp.eof;
                return finish({
                  forwardAdj,
                  reverseAdj,
                  kindOf,
                  ledger_mtime_ms: currentMtime ?? 0,
                  built_at: new Date().toISOString(),
                  checkpoint: newCp,
                  _mode: "incremental",
                  // Size-gated persist: bound the delta a fresh process
                  // re-folds without rewriting a ~40 MB file per start. A
                  // re-baselined witness MUST land or every load re-overflows.
                  _needsPersist: rebaselined || deltaBytes > PERSIST_DELTA_BYTES_CAP,
                  _rowsFolded: rows,
                });
              }
              // Fold error (shrink/rewrite between pin and read): fail closed
              // into the full rebuild below — the partially-folded maps are
              // DISCARDED (they describe a file that no longer exists).
            }
            // Corrupt v2 body → full rebuild below.
          }
          // Discontinuity / capture failure → full rebuild below.
        }
      }
    } catch {
      // Corrupt cache → fall through to full rebuild.
    }
  }

  // FULL REBUILD — pin-first checkpoint fold so the persisted payload carries
  // an exact-coverage checkpoint; tolerant-stream fallback certifies nothing.
  let forwardAdj = new Map();
  let reverseAdj = new Map();
  let kindOf = new Map();
  let checkpoint = null;
  let rowsFolded = 0;
  const cp = captureCheckpoint(ledgerPath);
  if (cp !== null) {
    const { rows, error } = _foldGraphRows(
      ledgerPath,
      emptyCheckpoint(),
      cp,
      forwardAdj,
      reverseAdj,
      kindOf,
    );
    rowsFolded = rows;
    if (error === null) {
      checkpoint = cp;
    } else {
      forwardAdj = new Map();
      reverseAdj = new Map();
      kindOf = new Map();
      const s = streamLedgerIntoGraph(ledgerPath);
      forwardAdj = s.forwardAdj;
      reverseAdj = s.reverseAdj;
      kindOf = s.kindOf;
    }
  } else if (existsSync(ledgerPath)) {
    const s = streamLedgerIntoGraph(ledgerPath);
    forwardAdj = s.forwardAdj;
    reverseAdj = s.reverseAdj;
    kindOf = s.kindOf;
  }
  return finish({
    forwardAdj,
    reverseAdj,
    kindOf,
    ledger_mtime_ms: currentMtime ?? 0,
    built_at: new Date().toISOString(),
    checkpoint,
    _mode: "full-rebuild",
    // Persist only when a checkpoint certifies exact coverage; a missing
    // ledger (checkpoint null, empty maps) must not churn the cache file.
    _needsPersist: checkpoint !== null,
    _rowsFolded: rowsFolded,
  });
}

/**
 * Persist the graph cache to disk. Atomic via tmp file + rename, mode 0600.
 *
 * v2 (R2/WI1): the payload is the sectioned binary described on
 * DERIVATION_GRAPH_SCHEMA_VERSION (id string table + Uint32 index sections)
 * instead of the 45.7 MB JSON monolith — the cold load drops from ~1135 ms to
 * ~440 ms measured on the production graph. The embedded serialized S1
 * checkpoint remains the validity carrier for the checkpoint-validated cold
 * seed; a graph without one persists with checkpoint:null (never trusted by
 * the cold seed — correct, slow next cold load). I/O stays on
 * node:fs/promises, off the event loop.
 *
 * @param {ReturnType<typeof rebuildDerivationGraph>} graph
 * @param {string} cachePath
 * @returns {Promise<void>}
 */
export async function persistGraphCache(graph, cachePath) {
  if (graph == null || !(graph.forwardAdj instanceof Map) || !(graph.reverseAdj instanceof Map)) {
    throw new TypeError("persistGraphCache: graph missing forwardAdj/reverseAdj Maps");
  }
  if (typeof cachePath !== "string" || cachePath.length === 0) {
    throw new TypeError("persistGraphCache: cachePath required");
  }

  // Pack BEFORE touching the filesystem: a pack failure (e.g. an id embedding
  // a newline) must leave the existing cache file untouched.
  const parts = _packGraphCacheV2({
    forwardAdj: graph.forwardAdj,
    reverseAdj: graph.reverseAdj,
    kindOf: graph.kindOf instanceof Map ? graph.kindOf : new Map(),
    ledger_mtime_ms: graph.ledger_mtime_ms,
    built_at: graph.built_at,
    checkpoint: graph.checkpoint ?? null,
  });

  const tmpPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
  const bytes = Buffer.concat(parts);
  try {
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(tmpPath, bytes, { mode: 0o600 });
    await rename(tmpPath, cachePath);
  } catch (err) {
    // Tmp hygiene: never leak a full-cache-sized tmp file per failed attempt.
    try {
      await rm(tmpPath, { force: true });
    } catch {
      // Cleanup is best-effort; the primary error is what matters.
    }
    throw err;
  }
}

/**
 * BFS the EXCISE channel: starting from `rootMemoryId`, walk reverseAdj
 * (parent → child) to enumerate downstream descendants. Capped at
 * PROPAGATION_DEPTH_MAX. The decayed_weight at depth d is
 * `DECAY_PER_HOP^(d-1)`; the walk halts on a branch when that value drops
 * below THRESHOLD_FLOOR.
 *
 * Yields `{memoryId, depth, decayed_weight}` per visited descendant, in
 * BFS-visit order. The root itself is NOT yielded — only its descendants.
 *
 * Cycle defense: a `visited` Set ensures the walk terminates gracefully even
 * if the ledger contains a (bug-induced) cycle.
 *
 * @param {{reverseAdj: Map<string, Set<string>>}} graph
 * @param {string} rootMemoryId
 * @returns {Iterable<{memoryId: string, depth: number, decayed_weight: number}>}
 */
export function* walkExcisePropagation(graph, rootMemoryId) {
  if (graph == null || !(graph.reverseAdj instanceof Map)) {
    throw new TypeError("walkExcisePropagation: graph missing reverseAdj Map");
  }
  if (typeof rootMemoryId !== "string" || rootMemoryId.length === 0) return;

  const visited = new Set();
  visited.add(rootMemoryId);
  // BFS queue of {id, depth}. depth=0 corresponds to the root (not emitted).
  const queue = [{ id: rootMemoryId, depth: 0 }];
  while (queue.length > 0) {
    const { id, depth } = queue.shift();
    if (depth >= PROPAGATION_DEPTH_MAX) {
      // Do not expand beyond the cap. Already-emitted nodes at depth ===
      // PROPAGATION_DEPTH_MAX are kept; their children would be at depth+1
      // which violates DEPTH-CAP.
      continue;
    }
    const children = graph.reverseAdj.get(id);
    if (children === undefined || children.size === 0) continue;
    for (const childId of children) {
      if (visited.has(childId)) continue;
      visited.add(childId);
      const childDepth = depth + 1;
      const childWeight = Math.pow(DECAY_PER_HOP, childDepth - 1);
      // THRESHOLD_FLOOR halts this branch — the child is NOT emitted and its
      // own descendants are NOT enqueued. Bounds work on pathological graphs.
      if (childWeight < THRESHOLD_FLOOR) continue;
      yield { memoryId: childId, depth: childDepth, decayed_weight: childWeight };
      queue.push({ id: childId, depth: childDepth });
    }
  }
}

/**
 * BFS the ENGAGEMENT channel: starting from `rootReconstructedId`, walk
 * forwardAdj (child → parents) to enumerate ancestor events whose
 * reinforcement budget should be incremented. Capped at PROPAGATION_DEPTH_MAX.
 *
 * The propagated_weight at depth d is `baseWeight * DECAY_PER_HOP^(d-1)`.
 * Branches below THRESHOLD_FLOOR are halted.
 *
 * Yields `{parentId, depth, propagated_weight}` per visited ancestor, in
 * BFS-visit order. The root itself is NOT yielded.
 *
 * STOP-AT-EVIDENCE (foundation spec § 4.4): if `graph.kindOf.get(parentId)`
 * is a known non-reconstructed kind (fact / policy / recall / …), the
 * ancestor is yielded but its own parents are NOT enqueued. Engagement
 * terminates at the evidence floor. Ancestors whose kind is unknown (not
 * present in kindOf) are treated as transit — the walk continues upward.
 *
 * Cycle defense: visited Set.
 *
 * @param {{forwardAdj: Map<string, Set<string>>, kindOf: Map<string, string>}} graph
 * @param {string} rootReconstructedId
 * @param {number} [baseWeight=1.0]
 * @returns {Iterable<{parentId: string, depth: number, propagated_weight: number}>}
 */
export function* walkEngagementPropagation(graph, rootReconstructedId, baseWeight = 1.0) {
  if (graph == null || !(graph.forwardAdj instanceof Map)) {
    throw new TypeError("walkEngagementPropagation: graph missing forwardAdj Map");
  }
  if (typeof rootReconstructedId !== "string" || rootReconstructedId.length === 0) return;
  const base = typeof baseWeight === "number" && Number.isFinite(baseWeight) && baseWeight > 0
    ? baseWeight
    : 1.0;

  const visited = new Set();
  visited.add(rootReconstructedId);
  const queue = [{ id: rootReconstructedId, depth: 0 }];
  while (queue.length > 0) {
    const { id, depth } = queue.shift();
    if (depth >= PROPAGATION_DEPTH_MAX) continue;
    const parents = graph.forwardAdj.get(id);
    if (parents === undefined || parents.size === 0) continue;
    for (const parentId of parents) {
      if (visited.has(parentId)) continue;
      visited.add(parentId);
      const parentDepth = depth + 1;
      const propagatedWeight = base * Math.pow(DECAY_PER_HOP, parentDepth - 1);
      if (propagatedWeight < THRESHOLD_FLOOR) continue;
      yield { parentId, depth: parentDepth, propagated_weight: propagatedWeight };
      // STOP-AT-EVIDENCE: terminate the branch at the first non-reconstructed
      // ancestor. The ancestor itself receives the propagation row, but its
      // own parents are not enqueued.
      const kind = graph.kindOf instanceof Map ? graph.kindOf.get(parentId) : undefined;
      if (kind !== undefined && kind !== "reconstructed") continue;
      queue.push({ id: parentId, depth: parentDepth });
    }
  }
}

/**
 * Detect cycles in the derivation graph. Returns an array of human-readable
 * cycle path strings (e.g. `"a → b → c → a"`). Empty array means the graph
 * is a DAG (the spec invariant).
 *
 * Implementation: iterative DFS over forwardAdj with a per-traversal recursion
 * Set. When the DFS revisits a node currently on the recursion stack, the
 * cycle path is reconstructed from the stack. Each cycle is reported at most
 * once (canonicalized by smallest member at the head).
 *
 * @param {{forwardAdj: Map<string, Set<string>>, reverseAdj: Map<string, Set<string>>}} graph
 * @returns {string[]} cycle paths (canonical, deduplicated)
 */
export function detectCycles(graph) {
  if (graph == null || !(graph.forwardAdj instanceof Map)) {
    throw new TypeError("detectCycles: graph missing forwardAdj Map");
  }
  const adj = graph.forwardAdj;
  const visited = new Set();
  const onStack = new Set();
  const stack = [];
  const cycles = new Map(); // canonical key → path string
  // Walk every node so disconnected components are covered.
  const allNodes = new Set();
  for (const k of adj.keys()) allNodes.add(k);
  if (graph.reverseAdj instanceof Map) {
    for (const k of graph.reverseAdj.keys()) allNodes.add(k);
  }

  function recordCycle(startId) {
    // Reconstruct the cycle from the current stack: from the first occurrence
    // of startId to the top, then back to startId.
    const idx = stack.indexOf(startId);
    if (idx < 0) return;
    const cyclePath = stack.slice(idx).concat([startId]);
    // Canonicalize by rotating so the lexicographically smallest member is
    // first (drop the trailing duplicate, rotate, then re-append).
    const core = cyclePath.slice(0, cyclePath.length - 1);
    let minIdx = 0;
    for (let i = 1; i < core.length; i++) {
      if (core[i] < core[minIdx]) minIdx = i;
    }
    const rotated = core.slice(minIdx).concat(core.slice(0, minIdx));
    const canonical = rotated.concat([rotated[0]]);
    const key = canonical.join("→");
    if (!cycles.has(key)) {
      cycles.set(key, canonical.join(" → "));
    }
  }

  function dfs(start) {
    // Iterative DFS using a manual stack of {id, iterator}.
    const frames = [];
    const childrenOf = (id) => {
      const s = adj.get(id);
      return s ? Array.from(s) : [];
    };
    frames.push({ id: start, children: childrenOf(start), nextIdx: 0 });
    stack.push(start);
    onStack.add(start);
    visited.add(start);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame.nextIdx >= frame.children.length) {
        // Backtrack
        frames.pop();
        stack.pop();
        onStack.delete(frame.id);
        continue;
      }
      const child = frame.children[frame.nextIdx++];
      if (onStack.has(child)) {
        recordCycle(child);
        continue;
      }
      if (visited.has(child)) continue;
      visited.add(child);
      onStack.add(child);
      stack.push(child);
      frames.push({ id: child, children: childrenOf(child), nextIdx: 0 });
    }
  }

  for (const node of allNodes) {
    if (visited.has(node)) continue;
    dfs(node);
  }
  return Array.from(cycles.values());
}

// Test-only: clear the module-scope append-aware projection cache so a fixture
// rebuild starts cold. Production code MUST NOT call this. Mirrors the
// _resetOffsetCaches discipline in ledger-offset-index.js.
export { _resetAppendAwareProjectionCache as _resetDerivationGraphCache } from "./append-aware-ledger-projection.js";
