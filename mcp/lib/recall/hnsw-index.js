// hnsw-index.js — Phase 3 v0 (recall layer / Layer 1 hybrid candidate gen).
//
// ANN index over MRL-768d Gemini vectors, per-embedding_model_version. Pairs
// with bm25-index.js to feed RRF fusion (k=60) in the hybrid retriever.
//
// Authoritative shape contracts: kb/phase3-v0-contracts.md.
// Authoritative spec: kb/research-retrieval-frontiers.md.
//
// BACKEND SELECTION:
//   This module tries to use hnswlib-node (native HNSW) at module load. If
//   that import fails (native compilation unavailable, or the package is not
//   installed because npm install failed in a sandboxed/offline env), it
//   falls back to a pure-JS LINEAR-SCAN implementation that wears the same
//   interface. At current scale (~1 fact in the ledger; ~10^2-10^3 facts
//   even after months of use) linear scan over 768d unit-norm vectors is
//   sub-millisecond — HNSW only becomes load-bearing at ~10^4+ entries.
//
//   The active backend is exported as HNSW_BACKEND ("hnswlib-node" or
//   "linear-scan") for diagnostics and test verification.
//
// LOAD-BEARING INVARIANTS:
//   - All vectors stored are MRL-sliced 768d, L2-renormalized to unit norm.
//   - On add(): assert vector.length === dims AND ||v||=1.0 +/- 1e-6 via
//     vector-math.l2NormAssert. Caller must do MRL slicing + renorm BEFORE
//     calling add(); this module does not embed.
//   - On search(): assert query_vector is unit-norm via l2NormAssert; this
//     catches the no-renorm-after-slice bug at the recall-query boundary.
//   - For unit-norm vectors, cosine similarity == inner product (dot). When
//     using hnswlib-node we set space="ip" — same result as "cosine" but
//     faster (no per-query renorm overhead inside the native lib).
//
// COSINE DISTANCE CONVENTION:
//   search() returns {cosine_distance, ...} where cosine_distance = 1 - dot.
//   Callers convert to similarity (sim = 1 - distance) when feeding into
//   the multi-feature scorer; this matches sklearn / Faiss conventions and
//   keeps "smaller is better" inside the ANN layer itself.
//
// REMOVAL DISCIPLINE:
//   hnswlib-node does not natively support deletion. We maintain a tombstone
//   Set<memory_id> that is consulted at search-time; tombstoned ids are
//   filtered from results AND the search is over-fetched (topK * 2, capped at
//   index size) so the post-filter result count is still close to topK. Save
//   files persist the tombstone set so reloads honor prior removals; a real
//   compaction pass is deferred to a future rebuild-index script.

import { l2NormAssert, DEFAULT_MRL_DIMS } from "../vector-math.js";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  openSync,
  readSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { Buffer } from "node:buffer";
import { StringDecoder } from "node:string_decoder";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Backend probe.
// ---------------------------------------------------------------------------

let _hnswlib = null;
let _backend = "linear-scan";
try {
  const mod = await import("hnswlib-node");
  // hnswlib-node is a CommonJS addon: under ESM interop HierarchicalNSW lives
  // on the default export, NOT as a named export. Accept either shape so the
  // native backend activates whether node hands us {HierarchicalNSW} directly
  // or {default:{HierarchicalNSW}}. (The original probe only checked the named
  // export and silently fell back to the O(N) linear scan even when the native
  // ANN addon was installed — that was the recall-latency root cause.)
  const resolved =
    mod && mod.HierarchicalNSW
      ? mod
      : mod && mod.default && mod.default.HierarchicalNSW
        ? mod.default
        : null;
  if (resolved && resolved.HierarchicalNSW) {
    _hnswlib = resolved;
    _backend = "hnswlib-node";
  }
} catch (_e) {
  // Native module unavailable. linear-scan is the fallback path.
  _hnswlib = null;
  _backend = "linear-scan";
}

export const HNSW_BACKEND = _backend;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DIMS = DEFAULT_MRL_DIMS; // 768
const DEFAULT_M = 16;
const DEFAULT_EF_CONSTRUCTION = 200;
const DEFAULT_EF_SEARCH = 50;
// Generous default so a fresh index has headroom for a growing personal corpus.
// (Was 100_000 — the corpus outgrew it and the cascade wedged; see add().)
//
// THIS NUMBER IS A COUNT CEILING THAT DOES NOT BIND, AND A MEMORY RESERVATION
// THAT DOES. The previous comment here said only "a starting capacity, not a
// hard ceiling", which is true about COUNTS and silently false about BYTES:
//
//   COUNTS — correct, and _nativeInsert is the enforcing symbol: it grows the
//   native graph before inserting, so exceeding this value is not an error.
//
//   BYTES — from the bundled hnswlib (node_modules/hnswlib-node/src/hnswlib/
//   hnswalg.h): maxM0_ = M_ * 2; size_links_level0_ = maxM0_ * sizeof(tableint)
//   + sizeof(linklistsizeint); size_data_per_element_ = size_links_level0_ +
//   data_size_ + sizeof(labeltype). With tableint/linklistsizeint = unsigned
//   int (4) and labeltype = size_t (8), that is hnswBytesPerElement() below.
//   Both the HierarchicalNSW ctor and loadIndex malloc
//   max_elements * size_data_per_element_ UP FRONT — not lazily, not per
//   insert. At the production shape (dims 4096, M 16) an element costs 16,524
//   bytes, so this constant reserves ~16.5 GB of address space on every index
//   construction, and resizeIndex reallocs the WHOLE base layer (a grow taken
//   at 1M elements peaks at old + new, ~50 GB).
//
// So the wall is real, it is denominated in bytes rather than elements, and it
// arrives with no warning of its own — hence capacityReport() and the two
// one-shot breadcrumbs in _nativeInsert. Raising this constant is NOT free.
const DEFAULT_MAX_ELEMENTS = 1_000_000;

// Fraction of capacity at which _nativeInsert emits its ONE-SHOT high-water
// breadcrumb. Env-overridable for operators; anything unparseable or outside
// (0, 1] falls back to the default rather than disabling the signal.
const HNSW_CAPACITY_WARN_FRACTION = (() => {
  const raw = Number(process.env.HNSW_CAPACITY_WARN_FRACTION);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.75;
})();

// WU-hnsw-ndjson-persistence — persisted-format versions.
//   v1 (LEGACY): a single monolithic JSON object {format,...,vectors:[[iid,[..]],..]}.
//       At 83k x 4096 floats this serialized object is ~6GB; JSON.parse of the
//       whole file blows the V8 ~512MB max-string cap on load. Still READABLE
//       (back-compat) when the file is small enough to JSON.parse safely.
//   v2 (CURRENT): NDJSON. LINE 1 is a header JSON; each subsequent line is one
//       vector {id, iid, v:[..]}. Both save and load STREAM — a multi-GB index
//       never materializes a whole-file JS string. New saves always emit v2.
const PERSIST_FORMAT_VERSION = 2;
const PERSIST_FORMAT_VERSION_LEGACY = 1;

// Hard guard for the legacy back-compat path: if an OLD monolithic file is
// larger than this, JSON.parse would crash on the ~512MB max-string cap. We
// throw a clear "rebuild required" error instead of letting the runtime die.
// 400MB leaves head-room below the V8 cap (the serialized object is larger than
// the on-disk bytes once parsed, and the parse itself needs the whole string).
const LEGACY_PARSE_MAX_BYTES = 400 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _validateVector(vector, dims, label) {
  if (
    !vector ||
    typeof vector.length !== "number" ||
    vector.length !== dims
  ) {
    throw new Error(
      `HnswIndex.${label}: vector must have length ${dims}, got ${vector && vector.length}`
    );
  }
  // l2NormAssert throws with a labeled message; rewrap so the layer is clear.
  l2NormAssert(vector, `HnswIndex.${label}`);
}

function _toPlainArray(vector) {
  // hnswlib-node accepts plain Array<number>; Float32Array also works in
  // recent versions but Array<number> is the safe lowest-common-denominator.
  if (Array.isArray(vector)) return vector;
  const out = new Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i];
  return out;
}

// Bytes one stored element occupies in the native base layer, per hnswalg.h:
//   size_data_per_element_ = (maxM0_ * sizeof(tableint) + sizeof(linklistsizeint))
//                            + data_size_ + sizeof(labeltype)
// with maxM0_ = M * 2, tableint = linklistsizeint = unsigned int (4 bytes),
// data_size_ = dims * sizeof(float), labeltype = size_t (8 bytes).
//
// Exported because sizing an index must NOT require building one: at the
// production shape a HierarchicalNSW ctor mallocs maxElements * this.
// Pure arithmetic — no allocation, no syscall, no native call.
export function hnswBytesPerElement(dims, M) {
  return 2 * M * 4 + 4 + dims * 4 + 8;
}

// The auto-grow target. SINGLE SOURCE OF TRUTH for the expression: _nativeInsert
// performs the grow and capacityReport() predicts it, and the two must never
// drift apart. Semantics are unchanged from the inline form this replaced.
function _growTargetElements(nativeCap, curCount) {
  return Math.max(nativeCap * 2, curCount + 1024);
}

function _dot(a, b) {
  // Caller guarantees a.length === b.length.
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// writeSync can return a short count (fewer bytes written than offered) on
// some platforms / large writes. Convert to a Buffer once and loop until the
// whole chunk is flushed so an NDJSON line is never truncated mid-vector.
function writeSyncWrap(fd, str) {
  const buf = Buffer.from(str, "utf8");
  let offset = 0;
  while (offset < buf.length) {
    offset += writeSync(fd, buf, offset, buf.length - offset);
  }
}

// ---------------------------------------------------------------------------
// Public class
// ---------------------------------------------------------------------------

export class HnswIndex {
  constructor({
    dims = DEFAULT_DIMS,
    embedding_model_version,
    M = DEFAULT_M,
    efConstruction = DEFAULT_EF_CONSTRUCTION,
    efSearch = DEFAULT_EF_SEARCH,
    maxElements = DEFAULT_MAX_ELEMENTS,
  } = {}) {
    if (!Number.isInteger(dims) || dims <= 0) {
      throw new Error(`HnswIndex: dims must be a positive integer, got ${dims}`);
    }
    if (typeof embedding_model_version !== "string" || embedding_model_version.length === 0) {
      throw new Error(
        "HnswIndex: embedding_model_version must be a non-empty string (per-version index discipline)"
      );
    }
    this.dims = dims;
    this.embedding_model_version = embedding_model_version;
    this.M = M;
    this.efConstruction = efConstruction;
    this.efSearch = efSearch;
    this.maxElements = maxElements;
    // One-shot latch for the capacity-mirror skew breadcrumb in
    // _nativeInsert. Initialized here so the instance shape is stable and the
    // hot path never reads an undefined property.
    this._capacitySkewWarned = false;
    // Sibling one-shot latches for the two capacity breadcrumbs in
    // _nativeInsert. Same rationale: whole-index replays route through that
    // method, so an unlatched warn would emit one line per point.
    this._capacityHighWaterWarned = false;
    this._capacityGrowWarned = false;

    // memory_id <-> internal integer id maps. hnswlib-node uses int labels;
    // linear-scan does not strictly need them but we keep the same maps for
    // parity (so save/load files are interchangeable conceptually).
    this._idForMemoryId = new Map(); // memory_id -> internal_id
    this._memoryIdForId = new Map(); // internal_id -> memory_id
    this._nextId = 0;

    // Tombstone set for removal (both backends honor it).
    this._tombstones = new Set(); // Set<memory_id>

    // Backend-specific state.
    if (HNSW_BACKEND === "hnswlib-node") {
      // space="ip" inner product. For UNIT-NORM vectors this equals cosine
      // similarity and avoids the native library's per-query renorm cost.
      // Distance returned by hnswlib under "ip" is 1 - dot; same convention
      // we expose. See module header for the cosine-distance convention.
      this._native = new _hnswlib.HierarchicalNSW("ip", dims);
      this._native.initIndex(maxElements, M, efConstruction);
      this._native.setEf(efSearch);
    } else {
      // Linear-scan storage: parallel arrays. Both indexed by internal_id.
      this._vectors = new Map(); // internal_id -> Array<number>
    }
  }

  size() {
    // Live count excludes tombstoned ids.
    return this._idForMemoryId.size - this._tombstones.size;
  }

  // W2-debounced-index-persistence — cheap membership probe used by the
  // pending-adds journal replay in index-cache.js. A memory_id counts as
  // present only when it is mapped AND not tombstoned (a tombstoned id is
  // eligible for re-add, so replay treats it as absent). Never throws.
  has(memory_id) {
    if (typeof memory_id !== "string" || memory_id.length === 0) return false;
    return this._idForMemoryId.has(memory_id) && !this._tombstones.has(memory_id);
  }

  // WU-dense-reembed-infra — index-side vector accessor for the recall s_emb
  // overlay. Every PRE-EXISTING fact's ledger row carries NO embedding_4096
  // (rowToIndexEntry leaves it null); its real 4096 vector lives ONLY in this
  // index (built from the sidecar). Layer-2 rescore needs that vector to score
  // s_emb>0 instead of 0. This getter returns the stored vector for a memory_id
  // WITHOUT mutating any fact row (thesis #1 — the index is a derived,
  // model-versioned projection).
  //
  // Returns:
  //   - Array<number> (the stored vector) for a live memory_id under the
  //     linear-scan backend (the active 4096 deployment is linear-scan: the
  //     persisted hnsw.bin is JSON with inline vectors).
  //   - null for an unknown id, a tombstoned id, or the hnswlib-node backend
  //     (the native index does not expose raw stored vectors; recall degrades
  //     that single candidate to s_emb=0 rather than throwing).
  //
  // Defensive: any unexpected internal state returns null (never throws) so a
  // single bad id cannot poison the whole rescore loop.
  getVectorByMemoryId(memory_id) {
    if (typeof memory_id !== "string" || memory_id.length === 0) return null;
    if (this._tombstones.has(memory_id)) return null;
    const internalId = this._idForMemoryId.get(memory_id);
    if (internalId === undefined) return null;
    if (HNSW_BACKEND === "hnswlib-node") {
      // Native backend: hnswlib-node DOES expose getPoint(label) -> the stored
      // vector. Reconstructing it here keeps the Layer-2 s_emb rescore working
      // for re-embedded EXISTING facts whose 4096 vector lives ONLY in the
      // index (not on the immutable ledger row). Without this the native ANN
      // path would silently score s_emb=0 for every legacy fact and trade
      // semantic quality for speed — the exact regression the latency fix must
      // NOT introduce. Defensive: any throw (missing label) -> null.
      try {
        const vec = this._native.getPoint(internalId);
        return Array.isArray(vec) ? vec : null;
      } catch {
        return null;
      }
    }
    const vec = this._vectors.get(internalId);
    return Array.isArray(vec) ? vec : null;
  }

  add(memory_id, vector) {
    if (typeof memory_id !== "string" || memory_id.length === 0) {
      throw new Error("HnswIndex.add: memory_id must be a non-empty string");
    }
    _validateVector(vector, this.dims, "add");

    // Duplicate add is an error — promote-time should compute the diff and
    // only call add for new memories. Silent overwrite would hide bugs.
    if (this._idForMemoryId.has(memory_id) && !this._tombstones.has(memory_id)) {
      throw new Error(
        `HnswIndex.add: memory_id ${memory_id} already present; remove() first or use a new memory_id`
      );
    }

    // Re-adding a tombstoned memory_id resurrects it.
    if (this._tombstones.has(memory_id)) {
      this._tombstones.delete(memory_id);
      // Replace the underlying vector at the existing internal id (linear-scan
      // path); hnswlib-node would need a true re-add but we keep the old
      // vector and clear the tombstone, which is correct as long as the
      // caller is replacing with the same vector. For Phase 3 v0 this branch
      // is exercised only by test 4 (remove+search); document for future.
      const id = this._idForMemoryId.get(memory_id);
      if (HNSW_BACKEND !== "hnswlib-node") {
        this._vectors.set(id, _toPlainArray(vector));
      }
      return;
    }

    const id = this._nextId++;
    this._idForMemoryId.set(memory_id, id);
    this._memoryIdForId.set(id, memory_id);

    if (HNSW_BACKEND === "hnswlib-node") {
      this._nativeInsert(id, vector);
    } else {
      this._vectors.set(id, _toPlainArray(vector));
    }
  }

  // Insert one (internal_id, vector) point into the native graph, growing
  // first when full. Auto-grow rationale (pre-S3g this lived inline in
  // add()): hnswlib fixes maxElements at initIndex(); once the index is
  // full, addPoint throws "The number of elements exceeds the specified
  // limit", which errors promoteSourceRow and FREEZES the source cursors
  // (root cause of the 2026-07-07 mail-cascade stall — the index was built
  // at the 100k default while the corpus grew past it). Grow with headroom
  // (double) so a growing corpus never wedges the cascade. Shared by add()
  // and the S3g backend-aware load paths (_storeLoadedVector).
  //
  // CAPACITY MIRROR — `this.maxElements` is a JS-side MIRROR, not the number
  // hnswlib enforces. On the native load path (_loadNativeSidecar) the mirror
  // is set from the hnsw.bin.meta.json sidecar via _newFromMeta, but the
  // native object is then rebuilt (`new HierarchicalNSW(...)` +
  // readIndexSync), adopting the capacity recorded in the .bin itself. The two
  // numbers have independent provenance, so a skewed pair makes
  // `curCount >= this.maxElements` false while hnswlib's own
  // cur_element_count >= max_elements_ is true: the guard stays silent and
  // addPoint throws "The number of elements exceeds the specified limit"
  // (the shape of the incident closed by commit 8bc1fa6). Guard on the
  // NATIVE's own reported capacity and reconcile the mirror to it.
  // The (count, capacity) pair as the NATIVE graph reports it, with the
  // feature-detect fallbacks that used to be inlined in _nativeInsert. Both
  // probes are cheap accessors on the addon — no allocation, no syscall — so
  // capacityReport() can share them with the insert path. Behaviour is
  // byte-identical to the inlined form; the extra `native &&` guard only makes
  // the method safe to call on the linear-scan runtime (where _native is
  // undefined), which _nativeInsert never is.
  _capacityPair() {
    const native = this._native;
    const curCount =
      native && typeof native.getCurrentCount === "function"
        ? native.getCurrentCount()
        : this._idForMemoryId.size;
    const nativeCap =
      native && typeof native.getMaxElements === "function"
        ? native.getMaxElements()
        : this.maxElements;
    return { curCount, nativeCap };
  }

  // OBSERVE-ONLY capacity/memory snapshot. Pure: it never resizes, never
  // mutates the mirror, allocates nothing but the returned object, and makes no
  // syscall — safe to call from a health probe on the hot path.
  //
  // `bytesPerElement` is the hnswalg.h formula (see hnswBytesPerElement), and
  // `nextGrowElements` uses the SAME helper the real grow uses, so the
  // prediction cannot drift from the behaviour.
  //
  // NOTE ON `dims`/`M`: like `maxElements` these are JS-side mirrors — on the
  // native load path they come from the hnsw.bin.meta.json sidecar while the
  // graph adopts whatever the .bin recorded. `count` and `maxElements` below
  // are read from the NATIVE's own report; dims/M are not separately probeable,
  // so a sidecar that misreports them would skew the byte figures.
  capacityReport() {
    const { curCount, nativeCap } = this._capacityPair();
    const bytesPerElement = hnswBytesPerElement(this.dims, this.M);
    const nextGrowElements = _growTargetElements(nativeCap, curCount);
    return {
      count: curCount,
      maxElements: nativeCap,
      dims: this.dims,
      M: this.M,
      bytesPerElement,
      reservedBytes: nativeCap * bytesPerElement,
      usedBytes: curCount * bytesPerElement,
      occupancy: nativeCap > 0 ? curCount / nativeCap : 0,
      nextGrowElements,
      nextGrowReservedBytes: nextGrowElements * bytesPerElement,
    };
  }

  _nativeInsert(id, vector) {
    const { curCount, nativeCap } = this._capacityPair();
    if (nativeCap !== this.maxElements) {
      // Loud EXACTLY ONCE per index instance: _storeLoadedVector funnels whole
      // -index replays through here, so an unlatched warn would emit one line
      // per point. Reconciliation is a plain assignment in BOTH directions —
      // we never resizeIndex merely to make the two numbers agree, because an
      // over-reporting mirror driving a resize is itself the bug (initIndex
      // mallocs maxElements x size_data_per_element_).
      if (!this._capacitySkewWarned) {
        this._capacitySkewWarned = true;
        console.error(
          `[hnsw-index] capacity mirror skew: sidecar/js maxElements=${this.maxElements} ` +
            `native getMaxElements()=${nativeCap} model=${this.embedding_model_version}`
        );
      }
      this.maxElements = nativeCap;
    }
    // HIGH-WATER — the cheap, loud, ONE-SHOT signal that this index is
    // approaching its reservation. Both operands are already computed above, so
    // this adds no syscall and no allocation to the steady state, and the latch
    // means at most one line per index instance. OBSERVE-ONLY: it never
    // resizes and never touches the mirror.
    //
    // Why it exists: nothing in the tree watched capacity. Four independent
    // greps (`maxElements`, `getMaxElements|resizeIndex`,
    // `capacity|occupanc|headroom`, `id_map`) turn up no probe, no health
    // reducer and no daemon reading either number — the first symptom of the
    // byte wall would have been an allocation failure inside resizeIndex.
    if (
      !this._capacityHighWaterWarned &&
      nativeCap > 0 &&
      curCount / nativeCap >= HNSW_CAPACITY_WARN_FRACTION
    ) {
      this._capacityHighWaterWarned = true;
      const bytesPerElement = hnswBytesPerElement(this.dims, this.M);
      console.error(
        `[hnsw-index] capacity high-water: count=${curCount} maxElements=${nativeCap} ` +
          `occupancy=${(curCount / nativeCap).toFixed(4)} ` +
          `bytesPerElement=${bytesPerElement} reservedBytes=${nativeCap * bytesPerElement} ` +
          `model=${this.embedding_model_version}`
      );
    }
    if (curCount >= nativeCap) {
      const grown = _growTargetElements(nativeCap, curCount);
      // GROW — announce the BYTE size of the realloc BEFORE attempting it,
      // because this is the operation that can take the process down and today
      // it happens in silence. hnswalg.h's resizeIndex reallocs the whole base
      // layer (new_max_elements * size_data_per_element_) and touches the old
      // block, so peak footprint is old + new. At the production shape a grow
      // from 1,000,000 elements would ask for ~33 GB on top of the ~16.5 GB
      // already held. Emitted before the call so the line survives the crash.
      if (!this._capacityGrowWarned) {
        this._capacityGrowWarned = true;
        const bytesPerElement = hnswBytesPerElement(this.dims, this.M);
        console.error(
          `[hnsw-index] capacity grow: resizeIndex ${nativeCap} -> ${grown} elements; ` +
            `requesting ${grown * bytesPerElement} bytes ` +
            `(bytesPerElement=${bytesPerElement}) while the current ` +
            `${nativeCap * bytesPerElement} bytes are still held; ` +
            `model=${this.embedding_model_version}`
        );
      }
      this._native.resizeIndex(grown);
      // Re-read the native's own report; `grown` is only the fallback for a
      // runtime without getMaxElements.
      //
      // resizeIndex failures propagate out of this method UNCAUGHT. They are
      // caught one level up, at the CALL SITES: all three
      // updateIndicesForFact({...}) invocations in tools/distill-promote-fact.js
      // wrap it in try/catch and continue. (The older wording here — "
      // updateIndicesForFact already catches and logs them" — was accurate but
      // imprecise: the catch is NOT inside updateIndicesForFact.) The
      // consequence is that an allocation failure degrades to a stderr
      // breadcrumb and a fact indexed nowhere, which is exactly why the grow is
      // announced above rather than only mourned afterwards.
      this.maxElements =
        typeof this._native.getMaxElements === "function"
          ? this._native.getMaxElements()
          : grown;
    }
    this._native.addPoint(_toPlainArray(vector), id);
  }

  // S3g INCIDENT FIX — backend-aware raw vector store for the LOAD paths of
  // the linear-scan on-disk formats (v1 monolithic `vectors` array and v2
  // NDJSON {id,iid,v} lines). Pre-fix both loaders poked idx._vectors
  // directly, but that map only exists on the linear-scan runtime: under
  // hnswlib-node the constructor builds _native instead, so a cold load of a
  // linear-scan-format hnsw.bin (the verified 2026-07-16 production shape at
  // indices/gemini-embedding-001 — a legacy format-1 blob under an adopted
  // generation manifest) threw "Cannot read properties of undefined
  // (reading 'set')", the manifest-gated loader refused the whole verified
  // generation, and recall served EMPTY. The fix feeds each (iid, vector)
  // into the native graph through the same auto-grow addPoint path add()
  // uses; the pure linear-scan runtime path is byte-for-byte unchanged.
  static _storeLoadedVector(idx, iid, vector) {
    if (HNSW_BACKEND === "hnswlib-node") {
      idx._nativeInsert(iid, vector);
    } else {
      idx._vectors.set(iid, vector);
    }
  }

  addBulk(items) {
    if (!Array.isArray(items)) {
      throw new Error("HnswIndex.addBulk: items must be an array");
    }
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it || typeof it !== "object") {
        throw new Error(`HnswIndex.addBulk: items[${i}] must be {memory_id, vector}`);
      }
      this.add(it.memory_id, it.vector);
    }
  }

  remove(memory_id) {
    if (typeof memory_id !== "string" || memory_id.length === 0) {
      throw new Error("HnswIndex.remove: memory_id must be a non-empty string");
    }
    if (!this._idForMemoryId.has(memory_id)) {
      // Not present — no-op. Avoid throwing because excise flows may call
      // remove() opportunistically for memories that never made it into the
      // index (e.g. promote-time embed failure left the row without an
      // inline vector and backfill had not yet reached it).
      return;
    }
    this._tombstones.add(memory_id);
  }

  search(query_vector, topK) {
    if (!Number.isInteger(topK) || topK <= 0) {
      throw new Error(`HnswIndex.search: topK must be a positive integer, got ${topK}`);
    }
    _validateVector(query_vector, this.dims, "search");

    const live = this.size();
    if (live === 0) return [];

    // Over-fetch to compensate for tombstone post-filtering. Cap at the live
    // count + tombstone count so we never ask for more than what exists.
    const total = this._idForMemoryId.size;
    const fetch = Math.min(total, Math.max(topK * 2, topK + this._tombstones.size));

    let results;
    if (HNSW_BACKEND === "hnswlib-node") {
      // hnswlib-node returns {distances: number[], neighbors: number[]}
      const r = this._native.searchKnn(_toPlainArray(query_vector), fetch);
      results = r.neighbors.map((id, i) => ({
        internal_id: id,
        distance: r.distances[i],
      }));
    } else {
      // Linear scan: compute 1 - dot for every live vector.
      const tmp = [];
      for (const [id, vec] of this._vectors.entries()) {
        const mid = this._memoryIdForId.get(id);
        if (this._tombstones.has(mid)) continue;
        const dot = _dot(query_vector, vec);
        tmp.push({ internal_id: id, distance: 1 - dot });
      }
      tmp.sort((a, b) => a.distance - b.distance);
      results = tmp.slice(0, fetch);
    }

    // Post-filter tombstones (only needed for the hnswlib-node path; linear
    // scan already excluded them above) and map back to memory_ids.
    const out = [];
    for (const r of results) {
      const mid = this._memoryIdForId.get(r.internal_id);
      if (!mid) continue;
      if (this._tombstones.has(mid)) continue;
      out.push({
        memory_id: mid,
        cosine_distance: r.distance,
        rank: out.length,
      });
      if (out.length >= topK) break;
    }
    return out;
  }

  // Serialize. For hnswlib-node, writes a .bin via writeIndex AND a sidecar
  // .json with id maps + tombstones. For linear-scan, STREAMS an NDJSON file
  // (header line + one line per vector) so a multi-GB index never materializes
  // a whole-file JS string. See PERSIST_FORMAT_VERSION docs.
  //
  // S3 — returns the artifact binding {path, metaPath, format, backend, dims,
  // embedding_model_version} so the caller (index-cache.js saveIndices) can
  // bind bin + meta + model metadata into ONE generation manifest. The two
  // renames below are no longer the publication event: they land the members
  // at the caller-chosen path, and the manifest's single atomic rename is
  // what publishes the generation. On-disk formats are byte-identical.
  save(path) {
    if (typeof path !== "string" || path.length === 0) {
      throw new Error("HnswIndex.save: path must be a non-empty string");
    }
    const dir = dirname(path);
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    if (HNSW_BACKEND === "hnswlib-node") {
      // hnswlib-node's writeIndex writes the native binary. Sidecar JSON
      // carries the id maps; the .bin alone cannot reconstruct memory_ids.
      // The native backend persists its own binary, so the sidecar stays a
      // small monolithic JSON — the >512MB string risk is the inline-vectors
      // (linear-scan) path only. We keep the sidecar at the CURRENT format
      // version for consistency.
      const meta = {
        format: PERSIST_FORMAT_VERSION,
        backend: HNSW_BACKEND,
        dims: this.dims,
        embedding_model_version: this.embedding_model_version,
        M: this.M,
        efConstruction: this.efConstruction,
        efSearch: this.efSearch,
        maxElements: this.maxElements,
        nextId: this._nextId,
        id_map: Array.from(this._idForMemoryId.entries()),
        tombstones: Array.from(this._tombstones),
      };
      // hnswlib-node's async writeIndex returns a Promise; save() is sync, so
      // calling the async form here let the process exit BEFORE the native
      // binary flushed — the graph persisted EMPTY (count=0 on reload) and
      // recall silently degraded to BM25-only. Use the synchronous variant so
      // the binary is fully written before we stamp the sidecar.
      //
      // W2-debounced-index-persistence — ATOMIC generation swap. The old code
      // wrote the native binary DIRECTLY over the live path, so a concurrent
      // loadIndices (or a crash mid-write) could observe a torn hnsw.bin.
      // Write both files to a tmp path and renameSync into place. ORDER
      // MATTERS: binary first, then meta — load() probes the .meta.json
      // sidecar to pick the native branch, so meta-last means a reader never
      // sees a meta that points at a torn/absent binary. On-disk formats are
      // byte-identical to before (same binary, same meta JSON); only the
      // write path changed.
      const metaPath = path + ".meta.json";
      const binTmp = `${path}.tmp-${process.pid}`;
      const metaTmp = `${metaPath}.tmp-${process.pid}`;
      try {
        this._native.writeIndexSync(binTmp);
        // S3 FIX CYCLE 2 (followup a) — fsync the written binary at fd level
        // BEFORE the rename, parity with the meta sidecar below. The native
        // writeIndexSync flushes through its own stdio but never fsyncs, so
        // pre-fix the rename could land while the bin's pages were still
        // dirty: a crash then published a generation manifest whose
        // checksummed hnsw member had never fully reached disk (the manifest
        // activation fsync covers only the manifest bytes, not the members).
        const binFd = openSync(binTmp, "r");
        try {
          fsyncSync(binFd);
        } finally {
          closeSync(binFd);
        }
        renameSync(binTmp, path);
        // S3 — fd-level write + fsync for the sidecar (bytes identical to the
        // previous writeFileSync; only durability changed): the generation
        // manifest checksums these bytes and is activated after them, so the
        // members must be durable before the manifest's publication rename.
        const metaFd = openSync(metaTmp, "w");
        try {
          writeSyncWrap(metaFd, JSON.stringify(meta));
          fsyncSync(metaFd);
        } finally {
          closeSync(metaFd);
        }
        renameSync(metaTmp, metaPath);
      } catch (e) {
        // A failed save must never leave stray tmp files that a later save
        // (same pid) would half-trust; best-effort cleanup, then rethrow.
        for (const tmp of [binTmp, metaTmp]) {
          try {
            if (existsSync(tmp)) unlinkSync(tmp);
          } catch (_e) {
            /* ignore */
          }
        }
        throw e;
      }
      // Best-effort dir fsync so the renames are durable (same discipline as
      // the linear-scan branch below).
      try {
        const dirFd = openSync(dir || ".", "r");
        try {
          fsyncSync(dirFd);
        } finally {
          closeSync(dirFd);
        }
      } catch (_e) {
        // best-effort
      }
      return this._saveResult(path, metaPath);
    }

    // Linear-scan: STREAM NDJSON to a tmp file, fsync, atomic rename. The
    // header carries everything load() needs except the vectors; each vector
    // is its own line {id: memory_id, iid, v:[floats]}. id_map is reconstructed
    // on load from the per-vector (id, iid) pairs, so it is NOT duplicated in
    // the header (that would re-introduce a large in-header array).
    const header = {
      format: PERSIST_FORMAT_VERSION,
      backend: HNSW_BACKEND,
      dims: this.dims,
      embedding_model_version: this.embedding_model_version,
      M: this.M,
      efConstruction: this.efConstruction,
      efSearch: this.efSearch,
      maxElements: this.maxElements,
      nextId: this._nextId,
      count: this._vectors.size,
      tombstones: Array.from(this._tombstones),
    };

    const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
    this._writeNdjsonSync(tmpPath, header);

    // Atomic rename into place, then fsync the containing directory so the
    // rename itself is durable.
    renameSync(tmpPath, path);
    try {
      const dirFd = openSync(dir || ".", "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch (_e) {
      // Directory fsync is best-effort (some filesystems reject it, e.g. on
      // some network/temp filesystems); the per-file fsync inside
      // _writeNdjsonSync already guarantees the bytes themselves are on disk.
    }
    return this._saveResult(path, null);
  }

  // S3 — the artifact binding save() hands back so the caller can bind the
  // written members (and the model metadata at hnsw-index.js save()'s meta
  // header) into a generation manifest. metaPath is null for the
  // single-file linear-scan format.
  _saveResult(path, metaPath) {
    return {
      path,
      metaPath,
      format: PERSIST_FORMAT_VERSION,
      backend: HNSW_BACKEND,
      dims: this.dims,
      embedding_model_version: this.embedding_model_version,
    };
  }

  // Write the NDJSON body to tmpPath one line at a time via a file descriptor,
  // then fsync the file. SYNCHRONOUS by contract: callers (saveIndices in
  // index-cache.js, reembed-local-4096.mjs) call save() without awaiting and
  // immediately stat the file, so the file must exist + be durable on return.
  //
  // CRITICAL: this never concatenates the whole file into one JS string. Each
  // line (header, then one {id,iid,v} per vector) is serialized + written on
  // its own, so peak string size is bounded by the heaviest single vector line
  // (~one 4096-float array), not the whole multi-GB index. This is the bug fix.
  _writeNdjsonSync(tmpPath, header) {
    let fd = null;
    try {
      fd = openSync(tmpPath, "w");
      writeSyncWrap(fd, JSON.stringify(header) + "\n");
      for (const [iid, vec] of this._vectors.entries()) {
        const mid = this._memoryIdForId.get(iid);
        // One line per vector; serialized in isolation (never accumulated).
        writeSyncWrap(fd, JSON.stringify({ id: mid, iid, v: vec }) + "\n");
      }
      fsyncSync(fd);
    } catch (e) {
      // Clean up the partial tmp file so a failed save never leaves a corrupt
      // half-written NDJSON that a later load() would choke on.
      if (fd != null) {
        try {
          closeSync(fd);
        } catch (_e) {
          /* ignore */
        }
        fd = null;
      }
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      } catch (_e) {
        /* ignore */
      }
      throw e;
    } finally {
      if (fd != null) {
        try {
          closeSync(fd);
        } catch (_e) {
          /* ignore */
        }
      }
    }
  }

  // Load from a save() path. opts may override efSearch for the loaded index.
  //
  // Three on-disk shapes are handled:
  //   1. hnswlib-node:  small monolithic sidecar `<path>.meta.json` + native
  //      `<path>` binary. Sidecar is small (id maps only) — JSON.parse is safe.
  //   2. v2 NDJSON (CURRENT linear-scan): header line + one vector/line. STREAMED
  //      line-by-line — never readFileSync the whole (multi-GB) body. THE FIX.
  //   3. v1 legacy monolithic (linear-scan): the old single JSON object with
  //      inline `vectors`. Still readable IFF the file is small enough to
  //      JSON.parse; if it exceeds LEGACY_PARSE_MAX_BYTES we throw a clear
  //      "rebuild required" error instead of crashing on the ~512MB string cap.
  static load(path, opts = {}) {
    if (typeof path !== "string" || path.length === 0) {
      throw new Error("HnswIndex.load: path must be a non-empty string");
    }

    // Probe: hnswlib-node sidecar (.meta.json) vs linear-scan single file.
    const sidecarPath = path + ".meta.json";
    if (existsSync(sidecarPath)) {
      return HnswIndex._loadNativeSidecar(path, sidecarPath, opts);
    }

    if (!existsSync(path)) {
      throw new Error(`HnswIndex.load: no index file at ${path}`);
    }

    // Distinguish v2 NDJSON from v1 monolithic by reading ONLY the first line.
    // Both start with a JSON object, but the v1 object's first newline (if any)
    // is buried deep, whereas v2's first line is the compact header ending in
    // "\n". We read a bounded prefix and parse the first newline-delimited
    // chunk; if its `format` is the current NDJSON version we stream the rest.
    const firstLine = HnswIndex._readFirstLine(path);
    let firstObj = null;
    try {
      firstObj = JSON.parse(firstLine);
    } catch (_e) {
      firstObj = null;
    }

    if (firstObj && firstObj.format === PERSIST_FORMAT_VERSION) {
      return HnswIndex._loadNdjson(path, firstObj, opts);
    }

    // Otherwise treat as legacy v1 monolithic. Guard the parse by file size.
    return HnswIndex._loadLegacyMonolithic(path, opts);
  }

  // hnswlib-node: small sidecar JSON + native binary. Unchanged from v1 except
  // it now accepts either persisted format version in the sidecar.
  static _loadNativeSidecar(path, sidecarPath, opts) {
    const meta = JSON.parse(readFileSync(sidecarPath, "utf8"));
    if (
      meta.format !== PERSIST_FORMAT_VERSION &&
      meta.format !== PERSIST_FORMAT_VERSION_LEGACY
    ) {
      throw new Error(
        `HnswIndex.load: unsupported sidecar format version ${meta.format}; ` +
          `expected ${PERSIST_FORMAT_VERSION} or ${PERSIST_FORMAT_VERSION_LEGACY}`
      );
    }
    if (meta.backend === "hnswlib-node" && HNSW_BACKEND !== "hnswlib-node") {
      throw new Error(
        "HnswIndex.load: index file was written with hnswlib-node backend but " +
          "the current runtime only has linear-scan; cannot decode native binary"
      );
    }
    const idx = HnswIndex._newFromMeta(meta, opts);
    idx._nextId = meta.nextId;
    for (const [mid, iid] of meta.id_map) {
      idx._idForMemoryId.set(mid, iid);
      idx._memoryIdForId.set(iid, mid);
    }
    for (const mid of meta.tombstones) idx._tombstones.add(mid);

    idx._native = new _hnswlib.HierarchicalNSW("ip", meta.dims);
    // Synchronous read — readIndex is async (Promise) in hnswlib-node, and
    // load() is sync; the async form returned before the graph populated, so
    // search() saw an empty index. readIndexSync fully materializes the graph
    // before we hand the index to the recall pipeline.
    idx._native.readIndexSync(path, true);
    idx._native.setEf(idx.efSearch);
    return idx;
  }

  // v2 NDJSON streamed load. header is the already-parsed first line. We read
  // the rest of the file in fixed-size chunks (via readSync) and split on
  // newlines, parsing one vector object at a time. The whole-file string is
  // NEVER materialized — peak resident string is one chunk + one residual line.
  static _loadNdjson(path, header, opts) {
    if (header.backend === "hnswlib-node" && HNSW_BACKEND !== "hnswlib-node") {
      throw new Error(
        "HnswIndex.load: index file was written with hnswlib-node backend but " +
          "the current runtime only has linear-scan; cannot decode native binary"
      );
    }
    const idx = HnswIndex._newFromMeta(header, opts);
    // nextId + tombstones come straight from the header; id_map is rebuilt from
    // each vector line's (id, iid) pair as we stream.
    idx._nextId = header.nextId;
    if (Array.isArray(header.tombstones)) {
      for (const mid of header.tombstones) idx._tombstones.add(mid);
    }

    const CHUNK = 1 << 20; // 1 MiB read window.
    const buf = Buffer.allocUnsafe(CHUNK);
    // StringDecoder buffers any partial multi-byte UTF-8 sequence that straddles
    // a chunk boundary, so a memory_id with non-ASCII bytes is never corrupted.
    const decoder = new StringDecoder("utf8");
    let fd = null;
    let residual = "";
    let isFirstLine = true;
    try {
      fd = openSync(path, "r");
      let bytesRead = 0;
      do {
        bytesRead = readSync(fd, buf, 0, CHUNK, null);
        if (bytesRead <= 0) break;
        residual += decoder.write(buf.subarray(0, bytesRead));
        let nl;
        while ((nl = residual.indexOf("\n")) !== -1) {
          const line = residual.slice(0, nl);
          residual = residual.slice(nl + 1);
          if (isFirstLine) {
            // First line is the header we already parsed; skip re-parsing it.
            isFirstLine = false;
            continue;
          }
          HnswIndex._absorbNdjsonLine(idx, line);
        }
      } while (bytesRead > 0);
      residual += decoder.end();
      // Trailing line with no terminating newline (defensive — save() always
      // newline-terminates, but a truncated file should not silently drop it).
      if (!isFirstLine && residual.length > 0) {
        HnswIndex._absorbNdjsonLine(idx, residual);
      }
    } finally {
      if (fd != null) {
        try {
          closeSync(fd);
        } catch (_e) {
          /* ignore */
        }
      }
    }
    return idx;
  }

  // Parse + ingest a single NDJSON vector line into idx. Malformed lines are
  // tolerated (logged-and-skipped, never throws) so one corrupt line cannot
  // abort the entire load — matches the reembed sidecar's defensive posture.
  static _absorbNdjsonLine(idx, line) {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let o;
    try {
      o = JSON.parse(trimmed);
    } catch (_e) {
      return; // malformed line tolerated
    }
    if (
      !o ||
      typeof o !== "object" ||
      typeof o.id !== "string" ||
      o.id.length === 0 ||
      typeof o.iid !== "number" ||
      !Array.isArray(o.v)
    ) {
      return; // structurally invalid line tolerated
    }
    // S3g — backend-aware store (see _storeLoadedVector): on the native
    // runtime the vector goes into the graph via addPoint; a native insert
    // failure (e.g. wrong-dims vector) is tolerated like any other bad line
    // — logged and skipped, id maps untouched — preserving this method's
    // never-throws contract. Linear-scan behavior is unchanged.
    try {
      HnswIndex._storeLoadedVector(idx, o.iid, o.v);
    } catch (e) {
      console.error(
        `HnswIndex._absorbNdjsonLine: skipping vector for ${o.id}: ${e.message}`,
      );
      return;
    }
    idx._idForMemoryId.set(o.id, o.iid);
    idx._memoryIdForId.set(o.iid, o.id);
  }

  // v1 legacy monolithic load. Size-guarded: a file larger than
  // LEGACY_PARSE_MAX_BYTES would crash JSON.parse on V8's ~512MB max-string cap,
  // so we throw a clear, actionable "rebuild required" error instead.
  static _loadLegacyMonolithic(path, opts) {
    let size = 0;
    try {
      size = statSync(path).size;
    } catch (_e) {
      size = 0;
    }
    if (size > LEGACY_PARSE_MAX_BYTES) {
      throw new Error(
        `HnswIndex.load: legacy v${PERSIST_FORMAT_VERSION_LEGACY} monolithic ` +
          `index at ${path} is ${size} bytes (> ${LEGACY_PARSE_MAX_BYTES} guard); ` +
          "JSON.parse would exceed the V8 max-string cap. Rebuild this index in " +
          `the streamed v${PERSIST_FORMAT_VERSION} NDJSON format (e.g. via the ` +
          "reembed --build-hnsw path) before loading."
      );
    }
    const meta = JSON.parse(readFileSync(path, "utf8"));
    if (
      meta.format !== PERSIST_FORMAT_VERSION_LEGACY &&
      meta.format !== PERSIST_FORMAT_VERSION
    ) {
      throw new Error(
        `HnswIndex.load: unsupported format version ${meta.format}; ` +
          `expected ${PERSIST_FORMAT_VERSION} or ${PERSIST_FORMAT_VERSION_LEGACY}`
      );
    }
    if (meta.backend === "hnswlib-node" && HNSW_BACKEND !== "hnswlib-node") {
      throw new Error(
        "HnswIndex.load: index file was written with hnswlib-node backend but " +
          "the current runtime only has linear-scan; cannot decode native binary"
      );
    }
    const idx = HnswIndex._newFromMeta(meta, opts);
    idx._nextId = meta.nextId;
    for (const [mid, iid] of meta.id_map) {
      idx._idForMemoryId.set(mid, iid);
      idx._memoryIdForId.set(iid, mid);
    }
    if (Array.isArray(meta.tombstones)) {
      for (const mid of meta.tombstones) idx._tombstones.add(mid);
    }
    if (Array.isArray(meta.vectors)) {
      for (const [id, vec] of meta.vectors) {
        // S3g — backend-aware store (see _storeLoadedVector). Pre-fix this
        // poked idx._vectors, which is undefined on the hnswlib-node
        // runtime: the legacy format-1 production hnsw.bin
        // (gemini-embedding-001) crashed here on every cold load and the
        // manifest-gated loader served empty. A native insert failure
        // propagates (fail-closed candidate refusal), matching this
        // method's existing strictness.
        HnswIndex._storeLoadedVector(idx, id, vec);
      }
    }
    return idx;
  }

  // Build an empty index from a parsed meta/header object (shared by all load
  // paths). opts.efSearch overrides the persisted efSearch.
  static _newFromMeta(meta, opts = {}) {
    return new HnswIndex({
      dims: meta.dims,
      embedding_model_version: meta.embedding_model_version,
      M: meta.M,
      efConstruction: meta.efConstruction,
      efSearch: opts.efSearch != null ? opts.efSearch : meta.efSearch,
      maxElements: meta.maxElements,
    });
  }

  // Read only up to the first newline of a file (bounded), returning that line
  // WITHOUT loading the whole file. Used to peek the NDJSON header / probe
  // format without a full readFileSync of a multi-GB body.
  static _readFirstLine(path) {
    const CHUNK = 1 << 16; // 64 KiB — far larger than any header line.
    const buf = Buffer.allocUnsafe(CHUNK);
    const decoder = new StringDecoder("utf8");
    let fd = null;
    let acc = "";
    try {
      fd = openSync(path, "r");
      let bytesRead = 0;
      // Read up to a few chunks looking for the first newline. A v1 monolithic
      // file may have no newline in its first chunk(s); cap the peek so we do
      // not accidentally slurp a huge single-line v1 file here.
      let peeked = 0;
      const PEEK_CAP = 1 << 20; // 1 MiB cap on the header peek.
      do {
        bytesRead = readSync(fd, buf, 0, CHUNK, null);
        if (bytesRead <= 0) break;
        peeked += bytesRead;
        acc += decoder.write(buf.subarray(0, bytesRead));
        const nl = acc.indexOf("\n");
        if (nl !== -1) return acc.slice(0, nl);
      } while (bytesRead > 0 && peeked < PEEK_CAP);
    } finally {
      if (fd != null) {
        try {
          closeSync(fd);
        } catch (_e) {
          /* ignore */
        }
      }
    }
    // No newline within the peek cap: return what we have (will fail to parse
    // as a header, routing to the legacy path which is size-guarded).
    return acc;
  }
}
