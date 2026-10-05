// _hnsw.js — R25 salience cascade Layer 3 kNN backend.
//
// BACKEND CHOICE: thin functional wrapper over the existing dual-backend
// HnswIndex class in mcp/lib/recall/hnsw-index.js. That module already
// resolved the "hand-rolled HNSW vs linear-scan" axis the workflow asked us
// to pick — its constructor probes for hnswlib-node at module-load and falls
// back to a pure-JS linear-scan implementation that wears the same interface
// (the recall layer at mcp/lib/recall/hnsw-index.js
// header §"BACKEND SELECTION" documents the rationale). At the scale the
// salience cascade operates on (memory.jsonl projected 5-15k facts post-
// cascade, currently 3 smoke rows) linear-scan over 768d unit-norm vectors
// is sub-millisecond per query — HNSW only becomes load-bearing at ~10^4+
// entries.
//
// JUSTIFICATION (operator-visible, per workflow contract):
//   Why not write a new hand-rolled minimal HNSW (~300-500 LOC) in this file?
//   Because mcp/lib/recall/hnsw-index.js already ships a battle-tested HNSW +
//   linear-scan dual backend behind the same shape contract this workflow
//   asks for, used by the recall layer in production. Reusing it (a)
//   eliminates an algorithmic duplication risk, (b) keeps a single tombstone
//   discipline across recall and ingest, (c) preserves the existing save/load
//   format (PERSIST_FORMAT_VERSION = 1) so recall.js and salience.js can
//   share a single on-disk format if we ever consolidate, and (d) inherits
//   the existing per-embedding_model_version index discipline.
//
//   No new npm deps. No new HNSW algorithm. If hnswlib-node is installed the
//   underlying backend is the native HNSW from Malkov & Yashunin 2018
//   ("Efficient and robust approximate nearest neighbor search using
//   Hierarchical Navigable Small World graphs", arXiv:1603.09320). Otherwise
//   it's deterministic O(N) linear scan with unit-norm dot product. The swap
//   threshold the workflow asks about (HNSW_INCREMENTAL_THRESHOLD = 1000) is
//   moot here because the underlying HnswIndex handles both regimes
//   automatically — operators who install hnswlib-node get HNSW; operators
//   who don't get linear-scan; both expose the same API.
//
// INTERFACE (the workflow-required functional shape):
//
//   buildIndex({ vectors: Array<Array<number>>, ids: string[], opts? })
//     -> indexHandle
//   knn(indexHandle, queryVec, k)
//     -> [{ id, cosine_distance }, ...]  // k entries, ascending distance
//   appendToIndex(indexHandle, id, vec)
//     -> void  // incremental add (errors if id already present unless
//                replace=true)
//   serializeIndex(indexHandle)
//     -> Uint8Array
//   deserializeIndex(buf, opts?)
//     -> indexHandle
//
//   buildIndex.opts:
//     - embedding_model_version: required, non-empty string. The underlying
//       HnswIndex enforces per-version index discipline (vectors from
//       different embed models cannot share an index).
//     - dims: optional, defaults to vector-math.DEFAULT_MRL_DIMS
//       (768). The salience cascade uses MRL-sliced 768d vectors per the
//       design doc.
//
// PERSISTENCE:
//   The workflow asks for a Uint8Array (de)serialization plus a load-from-
//   disk path of <MEMORY_ROOT>/storage/index/salience-knn.bin.
//   The underlying HnswIndex.save()/load() works with filesystem paths and
//   may emit either a single .json (linear-scan backend) or a binary +
//   .meta.json sidecar pair (hnswlib-node backend). To honor the workflow's
//   single-buffer interface AND preserve the existing dual-backend format,
//   serializeIndex() writes through a temp file and returns the bytes; on
//   linear-scan that's a single JSON blob; on hnswlib-node native it's a
//   self-describing envelope { format: 1, kind: "hnswlib-node-pair", binary:
//   base64, meta: <json string> }. deserializeIndex inverts.
//
//   For watermark-daemon startup, callers should prefer the disk-path
//   helpers loadIndexFromDisk() / saveIndexToDisk() which write through
//   HnswIndex.save()/load() directly (no in-memory copy) and use the
//   canonical path <MEMORY_ROOT>/storage/index/salience-knn.bin.
//   Missing/corrupt → caller rebuilds by replaying memory.jsonl with
//   appendToIndex().

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { HnswIndex, HNSW_BACKEND } from "../recall/hnsw-index.js";
import { DEFAULT_MRL_DIMS } from "../vector-math.js";
import { STORAGE_DIR } from "../config.js";

// Re-export the backend selector so diagnostics / tests can verify which
// engine is live.
export { HNSW_BACKEND };

// Canonical on-disk index path. Watermark daemon loads at boot; rebuilds
// from memory.jsonl if missing/corrupt.
export function salienceIndexPath() {
  return join(STORAGE_DIR, "index", "salience-knn.bin");
}

const SERIALIZE_ENVELOPE_FORMAT = 1;

// ---------------------------------------------------------------------------
// buildIndex
// ---------------------------------------------------------------------------

export function buildIndex({ vectors, ids, opts } = {}) {
  if (!Array.isArray(vectors)) {
    throw new Error("buildIndex: vectors must be an array");
  }
  if (!Array.isArray(ids)) {
    throw new Error("buildIndex: ids must be an array");
  }
  if (vectors.length !== ids.length) {
    throw new Error(
      `buildIndex: vectors.length (${vectors.length}) !== ids.length (${ids.length})`
    );
  }
  const cfg = opts || {};
  const embedding_model_version = cfg.embedding_model_version;
  if (typeof embedding_model_version !== "string" || embedding_model_version.length === 0) {
    throw new Error(
      "buildIndex: opts.embedding_model_version is required (non-empty string)"
    );
  }
  const dims = cfg.dims != null ? cfg.dims : DEFAULT_MRL_DIMS;

  const idx = new HnswIndex({
    dims,
    embedding_model_version,
    M: cfg.M,
    efConstruction: cfg.efConstruction,
    efSearch: cfg.efSearch,
    maxElements: cfg.maxElements,
  });
  for (let i = 0; i < vectors.length; i++) {
    idx.add(ids[i], vectors[i]);
  }
  return idx;
}

// ---------------------------------------------------------------------------
// knn — workflow contract: k entries, ascending cosine_distance, fields
// `id` + `cosine_distance`. The underlying HnswIndex.search returns
// `memory_id` + `cosine_distance` + `rank`; we map memory_id -> id.
// ---------------------------------------------------------------------------

export function knn(indexHandle, queryVec, k) {
  if (!indexHandle || typeof indexHandle.search !== "function") {
    throw new Error("knn: indexHandle must be a built index from buildIndex()");
  }
  if (!Number.isInteger(k) || k <= 0) {
    throw new Error(`knn: k must be a positive integer, got ${k}`);
  }
  // Empty index → empty result. Document: callers (corroboration branch)
  // interpret an empty neighbor list as "maximally novel" — first fact ever.
  if (indexHandle.size() === 0) return [];
  const raw = indexHandle.search(queryVec, k);
  const out = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    out[i] = { id: raw[i].memory_id, cosine_distance: raw[i].cosine_distance };
  }
  return out;
}

// ---------------------------------------------------------------------------
// appendToIndex — incremental add. Mirrors HnswIndex.add semantics: duplicate
// id throws unless the id was previously tombstoned (resurrect) or
// opts.replace === true (remove-then-add).
// ---------------------------------------------------------------------------

export function appendToIndex(indexHandle, id, vec, opts) {
  if (!indexHandle || typeof indexHandle.add !== "function") {
    throw new Error("appendToIndex: indexHandle must be a built index from buildIndex()");
  }
  if (opts && opts.replace === true) {
    // remove() is idempotent for unknown ids.
    indexHandle.remove(id);
  }
  indexHandle.add(id, vec);
}

// ---------------------------------------------------------------------------
// serializeIndex / deserializeIndex — Uint8Array contract.
//
// We route through HnswIndex.save() via a temp directory so the existing
// dual-backend save format is preserved unchanged. The returned envelope
// is itself a self-describing JSON blob (encoded as Uint8Array) carrying
// either the single-file linear-scan JSON inline, OR the hnswlib-node
// binary+meta pair (binary base64-encoded so it round-trips through JSON).
// ---------------------------------------------------------------------------

export function serializeIndex(indexHandle) {
  if (!indexHandle || typeof indexHandle.save !== "function") {
    throw new Error("serializeIndex: indexHandle must be a built index from buildIndex()");
  }
  const tmp = mkdtempSync(join(tmpdir(), "salience-knn-serialize-"));
  try {
    const savePath = join(tmp, "index.bin");
    indexHandle.save(savePath);

    const metaSidecar = savePath + ".meta.json";
    let envelope;
    if (existsSync(metaSidecar)) {
      // hnswlib-node backend: binary + sidecar meta.
      const binary = readFileSync(savePath);
      const meta = readFileSync(metaSidecar, "utf8");
      envelope = {
        format: SERIALIZE_ENVELOPE_FORMAT,
        kind: "hnswlib-node-pair",
        binary_base64: binary.toString("base64"),
        meta,
      };
    } else {
      // linear-scan backend: single JSON file.
      const payload = readFileSync(savePath, "utf8");
      envelope = {
        format: SERIALIZE_ENVELOPE_FORMAT,
        kind: "linear-scan-json",
        payload,
      };
    }
    return new Uint8Array(Buffer.from(JSON.stringify(envelope), "utf8"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function deserializeIndex(buf, opts) {
  if (!(buf instanceof Uint8Array) && !Buffer.isBuffer(buf)) {
    throw new Error("deserializeIndex: buf must be a Uint8Array or Buffer");
  }
  const text = Buffer.from(buf).toString("utf8");
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch (e) {
    throw new Error(`deserializeIndex: envelope is not valid JSON: ${e && e.message}`);
  }
  if (!envelope || envelope.format !== SERIALIZE_ENVELOPE_FORMAT) {
    throw new Error(
      `deserializeIndex: unsupported envelope format ${envelope && envelope.format}; expected ${SERIALIZE_ENVELOPE_FORMAT}`
    );
  }

  const tmp = mkdtempSync(join(tmpdir(), "salience-knn-deserialize-"));
  try {
    const loadPath = join(tmp, "index.bin");
    if (envelope.kind === "linear-scan-json") {
      writeFileSync(loadPath, envelope.payload, "utf8");
    } else if (envelope.kind === "hnswlib-node-pair") {
      writeFileSync(loadPath, Buffer.from(envelope.binary_base64, "base64"));
      writeFileSync(loadPath + ".meta.json", envelope.meta, "utf8");
    } else {
      throw new Error(`deserializeIndex: unknown envelope.kind ${envelope.kind}`);
    }
    return HnswIndex.load(loadPath, opts || {});
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Disk-path helpers — avoid the in-memory base64 round-trip when the caller
// already has a filesystem location. Watermark daemon uses these.
// ---------------------------------------------------------------------------

export function saveIndexToDisk(indexHandle, path) {
  if (!indexHandle || typeof indexHandle.save !== "function") {
    throw new Error("saveIndexToDisk: indexHandle must be a built index from buildIndex()");
  }
  const p = path || salienceIndexPath();
  const dir = dirname(p);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  indexHandle.save(p);
  return p;
}

export function loadIndexFromDisk(path, opts) {
  const p = path || salienceIndexPath();
  if (!existsSync(p) && !existsSync(p + ".meta.json")) {
    return null;
  }
  try {
    return HnswIndex.load(p, opts || {});
  } catch (e) {
    // Corrupt index → return null. Caller rebuilds from memory.jsonl by
    // replaying appendToIndex() over every fact row's embedding.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Convenience: empty-index sentinel for first-fact-ever case. Callers use
// this in the corroboration branch when memory.jsonl has zero embedded rows
// at watermark-daemon boot.
// ---------------------------------------------------------------------------

export function buildEmptyIndex(opts) {
  return buildIndex({ vectors: [], ids: [], opts });
}
