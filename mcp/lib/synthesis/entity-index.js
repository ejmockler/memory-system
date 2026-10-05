// entity-index.js — substrate-tier inverted index from
// canonical_id → [memory_id]. Implements F-SYN-SUBSTRATE-ENTITY-INDEX, which
// honors the contract pinned by docs/specs/synthesis/entity-schema.md and the
// "indices are derived from the ledger, never authoritative; treat as cache;
// rebuild from the ledger at any time" invariant from kb/architecture.md §5.
//
// Surface (per WU-entity-index-impl):
//
//   rebuildEntityIndex({ ledgerPath, cachePath? }) -> async {
//     entitiesByCanonicalId: Map<string, string[]>,  // canonical_id -> [memory_id]
//     ledgerMtime: number,                            // ms since epoch (statSync.mtimeMs)
//     built_at: ISO-8601 string,
//   }
//
//   loadOrRebuildIndex({ ledgerPath, cachePath? }) -> async <same shape>
//     - reads the cache file if present AND its `ledger_mtime_ms` matches the
//       ledger's current mtimeMs; otherwise rebuilds from the ledger and (when
//       a cachePath is provided) persists the freshly-built index.
//
//   lookupByEntity(index, canonical_id) -> string[]
//     - returns the array of memory_ids that mention the canonical_id, or
//       [] if no row in the ledger has stamped this canonical_id.
//
//   addToIndex(index, memoryId, entities) -> void
//     - in-memory add (no persistence). `entities` is the array as stamped on
//       a memory.jsonl row's `features.entities` (each element has at least a
//       string `canonical_id`). Tolerant of malformed entries.
//
//   persistIndex(index, cachePath) -> async void
//     - writes the JSON cache file at `cachePath` with mode 0600. Atomic via
//       tmp + rename so a torn write never poisons the on-disk cache.
//
// Cache file format (schema v1):
//
//   {
//     "schema_version": "v1",
//     "ledger_mtime_ms": <number>,
//     "entries": { "<canonical_id>": ["<memory_id>", ...] },
//     "built_at": "<ISO-8601>",
//     "checkpoint": { ... }   // C1, ADDITIVE + flag-gated (see below);
//                             // absent unless ENTITY_INDEX_CHECKPOINT_CACHE
//   }
//
// Invalidation discipline (mirrors recall/index-cache.js for BM25/HNSW and
// the transitive-orphan-map cache):
//   - The cache key on disk is the ledger's `mtimeMs` at the time of build.
//   - On every `loadOrRebuildIndex` we statSync the ledger; if the recorded
//     ledger_mtime_ms diverges (or the cache is missing/corrupt) we rebuild.
//   - The cache is a derived projection; deleting it is always safe — the
//     next call rebuilds from the ledger.
//
// Determinism / append-only invariant:
//   - The rebuild streams the ledger top-to-bottom and pushes one (memory_id,
//     canonical_id) pair per stamped entity. The memory_id order in each
//     bucket matches ledger order — same ledger → same index.
//   - We do NOT mutate ledger rows. Excision/tombstoning is the writer's
//     concern; this rebuild simply reflects whatever the ledger contains.
//
// C1 — WITNESS-CHECKPOINT CACHE VALIDATION (default-off flag
// ENTITY_INDEX_CHECKPOINT_CACHE=1|true):
//   MEASURED DEFECT: `ledger_mtime_ms === currentMtime` is the wrong axis for
//   an append-only ledger — the mtime moves on every daemon append while the
//   prefix bytes do not. On the live system the 33.7 MB cache recorded
//   1782135041389.2107 against a ledger mtime of 1785870328096.9207 (43.23
//   days apart), so the equality could never hold and EVERY cold process
//   discarded a valid cache and re-streamed 2,897,071,538 bytes (~153 s at
//   1.82 GB, append-aware-ledger-projection.js:10).
//
//   FIX (this flag): rebase cold-seed validity onto the S1 checkpoint
//   primitive already shipped next door — ledger-checkpoint.js
//   (captureCheckpoint / readAppended / serializeCheckpoint /
//   deserializeCheckpoint), with the branch structure of
//   content-index.js:476-637 and the resumeOffset shape of
//   derivation-graph.js:647-665. No new witness / hash / freshness scheme is
//   introduced here.
//
//   SCHEMA CHOICE: ENTITY_INDEX_SCHEMA_VERSION stays "v1" and `checkpoint` is
//   added ADDITIVELY (content-index bumped to v2 because it had no flag; C1
//   is gated by the flag instead). Consequences, all intentional:
//     - the v1 assertion at test/synthesis/entity-index.test.mjs:87 stays
//       green, so that file is never touched;
//     - a legacy payload with no `checkpoint` key deserializes to null and
//       falls through to exactly ONE full rebuild, which then stamps a
//       checkpoint (self-migrating);
//     - a flag-OFF reader simply ignores the extra key.
//   The FLAG, not the schema version, is the gate: with the flag unset the
//   code path and the persisted bytes are identical to the pre-C1 tree.
//
//   FLAG ON, cold-seed acceptance (mirrors content-index.js:476-637):
//     full rebuild ONLY on: no cache | cache-corrupt | schema-migration |
//     invalid-checkpoint | checkpoint-discontinuity | a delta read that
//     failed. `prefixVerified === true` is CONTINUITY, never a rebuild
//     trigger (ledger-checkpoint.js:292-308): reading it the other way forced
//     a full rebuild every ~63 updates in BOTH W1/H1 consumers. Do not
//     re-earn that bug.

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
// (existsSync is used for the disk-cache probe in _coldSeedEntityIndex and —
// under the C1 flag only — for the present-but-unreadable-ledger fail-static
// branch, mirroring content-index.js:517. The ledger-path existsSync guard on
// the READ path was removed in B1c3 — see streamLedgerIntoIndex.)
import { streamLedgerLines } from "./_ledger-stream.js";
// C1 — the S1 checkpoint primitive. Import-only reuse: capture/read/serialize
// live in ledger-checkpoint.js and are shared verbatim with content-index.js
// and derivation-graph.js.
import {
  captureCheckpoint,
  deserializeCheckpoint,
  emptyCheckpoint,
  readAppended,
  serializeCheckpoint,
} from "./ledger-checkpoint.js";
// WU-incrementalize-recall-recomputes — loadOrRebuildIndex re-streamed the full
// 1.82 GB ledger on a cold process (153 s, the worst single recall cost) and on
// every daemon-append cache miss. The shared append-aware tail-merge replays
// ONLY the appended bytes (entity buckets are append-only ADD, trivially
// mergeable). The disk cache remains a cold-start seed so a fresh process skips
// the full scan.
import {
  appendAwareLedgerProjection,
} from "./append-aware-ledger-projection.js";
// C4 — the ONE source-collapsing key function. Import-only reuse: the
// kind:source:slug -> kind:slug normalization lives in multi-feature-score.js
// (:577) and is shared verbatim with entityOverlapJaccard, so lookup and
// scoring can never disagree about identity. Re-implementing the 9 lines here
// is exactly the drift this node exists to close.
// No cycle: multi-feature-score.js imports append-aware-ledger-projection,
// ledger-checkpoint, config, validation, envelope, episodicity-scorer and
// feature-backfill — none of which import entity-index.js. The synthesis ->
// recall direction already has precedent (propensity-calculator.js:58).
import { entityMatchKey } from "../recall/multi-feature-score.js";

// Cache-partition id for the shared append-aware projection helper.
const ENTITY_INDEX_PROJECTION_NS = "entity-index";

/** Cache file schema version. Bump on any structural change to the on-disk
 *  shape. A schema mismatch on load triggers a full rebuild.
 *
 *  C1 deliberately did NOT bump this: the `checkpoint` key is ADDITIVE and
 *  gated by ENTITY_INDEX_CHECKPOINT_CACHE, so (a) flag-OFF bytes are
 *  unchanged, (b) a legacy payload without `checkpoint` migrates through one
 *  full rebuild, and (c) test/synthesis/entity-index.test.mjs:87's
 *  `=== "v1"` assertion stays green. See the C1 block in the file header. */
export const ENTITY_INDEX_SCHEMA_VERSION = "v1";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * C1 gate — is the witness-checkpoint cache validation enabled?
 *
 * DEFAULT OFF. Read at CALL time, never captured at module load: a single
 * process (the C1 suite) must be able to exercise flag-ON and flag-OFF cases
 * back to back after _resetEntityIndexCache(). Boolean-env convention copied
 * from the tree (recall.js:1298 `RECALL_PROF === "1"`;
 * distill-promote-fact.js:1509-1510 `=== "1" || === "true"`).
 */
function _checkpointCacheEnabled() {
  const v = process.env.ENTITY_INDEX_CHECKPOINT_CACHE;
  return v === "1" || v === "true";
}

/**
 * C4 gate — is source-agnostic (match-key) entity lookup enabled?
 *
 * DEFAULT OFF, same convention as _checkpointCacheEnabled above: read at CALL
 * time, never captured at module load, so one process can exercise flag-ON and
 * flag-OFF back to back. With the flag unset lookupByEntityMatchKey delegates
 * to lookupByEntity and the derived map is NEVER built — the flag-off path
 * costs exactly zero.
 *
 * WHY the flag exists: entitiesByCanonicalId is keyed on the EXACT
 * `kind:source:slug` id, so `lookupByEntity("file:git-log:mcp/lib/tools/recall.js")`
 * misses the identical artifact stamped as `file:telegram:mcp/lib/tools/recall.js`,
 * while multi-feature-score already scores the two as one entity. Measured on
 * the live 6,124-key storage/entity-index.cache.json, using the production
 * entityMatchKey and the same cross-bucket id dedup as this module: the 1,966
 * chat-claude-code exact keys reach 2,048 unique ids, while their match keys
 * reach 49,542 (24.19x). The largest bucket this lookup can ACTUALLY RETURN is
 * a single person bucket (e.g. person:alex_example_com) holding
 * hundreds of thousands of ids. It is a single-source git-log
 * bucket, but still gives the query side 100% new reach because recall.js:1438
 * hardcodes source=chat-claude-code. In total, 1,458 derived match-key buckets
 * exceed RECALL_SUBSTRATE_FALLBACK_MAX_CANDIDATES
 * (validation.js:166 = 50). That cap is why this ships UNWIRED: see the
 * ordering hazard note on lookupByEntityMatchKey below.
 */
function _matchKeyLookupEnabled() {
  const v = process.env.MEMORY_RECALL_ENTITY_MATCHKEY_LOOKUP;
  return v === "1";
}

/**
 * C4 — memo for the derived `Map<matchKey, string[]>`, keyed on the SOURCE
 * `entitiesByCanonicalId` Map OBJECT (not on the index wrapper, which is
 * re-created per loadOrRebuildIndex call while the Map itself is reused by the
 * append-aware projection). A WeakMap so a discarded index cannot pin its
 * derived twin in memory.
 *
 * Built LAZILY on the first flag-ON lookup — never at module load, never under
 * flag-OFF. Purely in-memory: the derived map is never serialized and
 * storage/entity-index.cache.json is never touched by this path.
 *
 * COST (live 6,124-key / 1,454,771-entry index): the first flag-ON lookup was
 * measured at 261 ms and +84.4 MB heap. WeakMap does NOT make that allocation
 * short-lived here: the source Map is held by the module-cached append-aware
 * projection, so its derived twin is retained for process lifetime, roughly
 * DOUBLING entity-index resident memory. This box has prior jetsam history;
 * do not enable the flag without budgeting that retained memory explicitly.
 *
 * STALENESS — entitiesByCanonicalId is mutated IN PLACE, so a memo keyed on
 * Map identity must be invalidated by every mutator. Both mutation paths run
 * through pushEntry():
 *   1. addToIndex() — the public incremental mutator.
 *   2. loadOrRebuildIndex()'s applyParsedRow callback — the append-aware
 *      tail-merge folds applyRow() into the SAME cached Map the previous call
 *      returned.
 * pushEntry invalidates after every actual append, closing both vectors at the
 * shared mutation primitive. The per-entry WeakMap.delete is intentional: it
 * is a no-op when flag-OFF (no derived twin exists), and makes it impossible
 * for an optional/swallowed projection callback to leave a stale memo behind.
 */
const _matchKeyMemo = new WeakMap();

/**
 * Drop the derived twin for a source Map after an in-place mutation.
 * A malformed hand-off is a programming error, never a silent no-op: serving
 * a stale pre-append result is worse than failing the mutation loudly.
 */
function _invalidateMatchKeyMemoForMap(byCanonicalId) {
  if (!(byCanonicalId instanceof Map)) {
    throw new TypeError(
      "invalidateMatchKeyMemo: expected entitiesByCanonicalId Map",
    );
  }
  _matchKeyMemo.delete(byCanonicalId);
}

/** Test-only probe: how many times the derived map has actually been built.
 *  Lets a suite prove the flag-OFF path constructs nothing. */
let _matchKeyDeriveCount = 0;

/**
 * Derive `Map<matchKey, string[]>` from an exact-keyed entity bucket Map.
 *
 * Order contract: source Map insertion order (= ledger order, since buckets
 * are created on first mention) is walked once and each bucket's ids are
 * appended under entityMatchKey(key). When N source buckets collapse onto one
 * key, an id present in several of them keeps its FIRST occurrence — the only
 * honest reading of "ledger order" across a merge, and the same
 * first-wins/no-duplicates contract pushEntry gives an exact bucket.
 */
function _deriveMatchKeyMap(byCanonicalId) {
  const derived = new Map();
  const seen = new Map(); // matchKey -> Set<memory_id> (dedup across sources)
  for (const [canonicalId, ids] of byCanonicalId) {
    const key = entityMatchKey(canonicalId);
    // entityMatchKey returns null only for a non-string / empty id, which
    // cannot be a Map key here; skip defensively rather than mint a "null" key.
    if (key === null) continue;
    if (!Array.isArray(ids)) continue;
    let bucket = derived.get(key);
    let dedup = seen.get(key);
    if (bucket === undefined) {
      bucket = [];
      derived.set(key, bucket);
      dedup = new Set();
      seen.set(key, dedup);
    }
    for (const id of ids) {
      if (dedup.has(id)) continue;
      dedup.add(id);
      bucket.push(id);
    }
  }
  _matchKeyDeriveCount += 1;
  return derived;
}

/**
 * Does `newCp` EXTEND `prevCp` — i.e. does it certify that the cached
 * [0, prevCp.eof) prefix is still byte-identical, so folding only the delta
 * over the cached entries is sound?
 *
 * Two equivalent signals, both produced by captureCheckpoint({prev}) itself
 * (ledger-checkpoint.js:379-388):
 *   - `extendedPrev === true` — prev verified INSIDE the capture call and its
 *     witness was reused verbatim (the capture-side statement of exactly this
 *     fact; derivation-graph.js:777-780 gates on it);
 *   - otherwise the caller-side structural check: prev.witness is a verbatim
 *     array-prefix of newCp.witness (content-index.js:276-290 keeps this as a
 *     private helper; ledger-checkpoint.js does not export it, so the check
 *     lives here rather than importing across sibling modules).
 * Every other capture outcome (prefix drift, shrink, atomic replacement,
 * io-error, witness-cap overflow) falls back to a FRESH sample whose entries
 * do not replay prev's — a non-extension is therefore the caller-visible
 * discontinuity signal. Trivially true for the origin cursor (empty witness).
 */
function witnessExtends(prevCp, newCp) {
  if (newCp.extendedPrev === true) return true;
  const pw = prevCp.witness;
  const nw = newCp.witness;
  if (nw.length < pw.length) return false;
  for (let i = 0; i < pw.length; i++) {
    if (
      pw[i].off !== nw[i].off ||
      pw[i].len !== nw[i].len ||
      pw[i].hash !== nw[i].hash
    ) {
      return false;
    }
  }
  return true;
}

/** Return the ledger's mtimeMs, or null ONLY if the ledger does not exist
 *  (ENOENT — the legal cold-start case). B1c3: any OTHER stat failure
 *  (parent-dir EACCES, ELOOP, ENOTDIR) means an EXISTING ledger we cannot
 *  see — swallowing that as null stamped a fingerprint-valid EMPTY index
 *  with ledger_mtime_ms 0, so it now throws (fail-closed, same shape as
 *  time-index.js's statLedger B1c2 throw). */
function statLedgerMtime(ledgerPath) {
  try {
    const s = statSync(ledgerPath);
    return s.mtimeMs;
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw new Error(
      `entity-index: ledger stat failed (fail-closed, B1c3): ${e && e.message ? e.message : String(e)}`,
    );
  }
}

/**
 * Add a single (canonical_id, memory_id) pair to the inverted-index Map.
 * Each canonical_id maps to an Array<memory_id>. We allow duplicates within
 * a bucket only if they came from genuinely distinct ledger rows (different
 * memory_ids); same-row duplicates are coalesced because a single row should
 * appear at most once per entity bucket.
 */
function pushEntry(byCanonicalId, canonicalId, memoryId) {
  let arr = byCanonicalId.get(canonicalId);
  if (arr === undefined) {
    arr = [];
    byCanonicalId.set(canonicalId, arr);
  }
  // De-dup against the last appended memory_id — the rebuild visits a single
  // ledger row in one shot, so consecutive duplicates would be a same-row
  // double-stamp. We also guard against arbitrary callers double-adding the
  // same (memory_id, canonical_id) pair through addToIndex.
  if (arr[arr.length - 1] === memoryId) return;
  // For non-adjacent duplicates (e.g. the same memory_id appeared earlier in
  // the bucket via an unrelated call path), skip to keep the bucket clean.
  if (arr.includes(memoryId)) return;
  arr.push(memoryId);
  // W3 — both public incremental adds and append-aware warm tail-merges reach
  // this exact mutation point. Invalidate here so the next flag-ON lookup can
  // never reuse a pre-append derived map. Under flag-OFF no memo exists, so
  // this changes no returned or persisted bytes.
  _invalidateMatchKeyMemoForMap(byCanonicalId);
}

/**
 * Apply a single ledger row to the in-progress entity index. Tolerates rows
 * without a `features.entities` array (returns silently) and rows whose
 * entities are malformed (each entity is checked individually).
 */
function applyRow(byCanonicalId, row) {
  if (row == null || typeof row !== "object") return;
  const memoryId = row.id;
  if (typeof memoryId !== "string" || memoryId.length === 0) return;
  const features = row.features;
  if (features == null || typeof features !== "object") return;
  const entities = features.entities;
  if (!Array.isArray(entities) || entities.length === 0) return;
  for (const e of entities) {
    if (e == null || typeof e !== "object") continue;
    const canonicalId = e.canonical_id;
    if (typeof canonicalId !== "string" || canonicalId.length === 0) continue;
    pushEntry(byCanonicalId, canonicalId, memoryId);
  }
}

/**
 * Parse the ledger file line-by-line into entity-index entries.
 * Returns the populated Map. Missing ledger → empty map (the cold-start case).
 *
 * B1c3 fail-closed: throws when the streamer reports a read failure OR a
 * skipped (over-maxLineBytes) line — BEFORE any index object is returned or
 * persisted, mirroring rebuildTimeIndex (time-index.js B1c/B1c2 gates). Both
 * rebuild entry points (rebuildEntityIndex and _coldSeedEntityIndex's
 * stream fallback) go through here, so no fingerprint-valid empty/partial
 * index can be projected from an unreadable or partially-read ledger.
 *
 * @param {string} ledgerPath
 * @param {{maxLineBytes?: number}} [opts] — per-line cap forwarded to
 *        streamLedgerLines (default 8 MiB there). Injectable so tests can
 *        prove the skipped-row gate without huge fixtures.
 */
function streamLedgerIntoIndex(ledgerPath, { maxLineBytes } = {}) {
  const byCanonicalId = new Map();
  // B1c3: the previous existsSync(ledgerPath) guard here conflated an
  // unreadable path (EACCES parent, ELOOP, ENOTDIR → existsSync false) with
  // a missing ledger. Shard A's streamLedgerLines now returns zeros with
  // readError null on ENOENT itself, so missing-ledger → empty map is
  // preserved without the guard, and every other errno surfaces below.
  //
  // RR2c — stream row-by-row. The previous readFileSync(ledgerPath,"utf8")
  // threw ERR_STRING_TOO_LONG (Node MAX_STRING_LENGTH ~512MB) on the 1.78GB
  // live ledger, which silently no-op'd the recall-time substrate entity
  // fallback (the entity-overlap rescue path). We keep only the inverted
  // index Map<canonical_id, fact_id[]>, never the full ledger string.
  //
  // B1c3 accepted tradeoff (mirrors time-index.js B1c2): the streamer's
  // default 8 MiB maxLineBytes is far above any legal row (put.js caps
  // content at CONTENT_MAX_CHARS=16384, validation.js:18), and if a row ever
  // bloats past the cap the skipped>0 gate below makes the drop LOUD instead
  // of silently projecting a partial index.
  const counts = streamLedgerLines(ledgerPath, (row) => {
    try {
      applyRow(byCanonicalId, row);
    } catch {
      // Defensive: a single malformed row never aborts the rebuild.
    }
  }, { maxLineBytes });

  // B1c3 fail-closed (deliberately mirroring time-index.js:251-265): a failed
  // read — open failure OR mid-stream I/O failure, per the _ledger-stream.js
  // readError contract — must be LOUD before any index is projected. A
  // missing ledger stays fine (readError null, zero rows → empty map).
  if (counts.readError !== null) {
    throw new Error(
      `rebuildEntityIndex: ledger read failed (fail-closed, B1c3): ${counts.readError}`,
    );
  }
  // Same policy for a valid-but-oversized row silently dropped by the
  // streamer (counted in skipped WITHOUT setting readError): refusing beats
  // a fingerprint-valid PARTIAL index.
  if (counts.skipped > 0) {
    throw new Error(
      `rebuildEntityIndex: ${counts.skipped} ledger line(s) exceeded maxLineBytes and were dropped by the streamer — refusing to project a partial index (fail-closed, B1c3)`,
    );
  }
  return byCanonicalId;
}

/**
 * C1 — fold exactly the terminated ledger rows in [fromCp.eof, toCp.eof) into
 * `byCanonicalId` through the SAME applyRow reducer the full stream uses, so
 * the delta path and the full rebuild have identical row semantics (only the
 * byte range differs). Mirrors content-index.js:225-236 / derivation-graph.js
 * :475-487. Never reads past toCp.eof — a torn tail and any row appended after
 * the pin are structurally out of range and fold exactly once on a later load.
 *
 * Returns { rows, error }: `rows` counts delivered (parse-attempted) lines;
 * `error` is readAppended's fail-closed error string, or null. B1c3 parity: a
 * line dropped for exceeding maxLineBytes is reported as an error too, so the
 * caller falls back to streamLedgerIntoIndex — whose skipped>0 gate makes the
 * drop LOUD instead of projecting a silent partial index.
 */
function _foldEntityRows(ledgerPath, fromCp, toCp, byCanonicalId) {
  let rows = 0;
  const res = readAppended(ledgerPath, fromCp, toCp, (text) => {
    rows += 1;
    try {
      applyRow(byCanonicalId, JSON.parse(text));
    } catch {
      // Defensive: a single malformed row never aborts the fold (parity with
      // streamLedgerIntoIndex's per-row tolerance).
    }
  });
  if (res.error === null && res.skipped_oversized > 0) {
    return { rows, error: "oversized-row" };
  }
  return { rows, error: res.error };
}

/**
 * Serialize a Map<string, string[]> into a plain object for JSON.
 * Iteration order of a Map is insertion order which keeps the on-disk file
 * deterministic for a given ledger.
 */
function serializeEntries(byCanonicalId) {
  const out = {};
  for (const [k, v] of byCanonicalId) {
    out[k] = v.slice();
  }
  return out;
}

/**
 * Deserialize the cache file's `entries` object back into a Map.
 */
function deserializeEntries(entries) {
  const map = new Map();
  if (entries == null || typeof entries !== "object") return map;
  for (const k of Object.keys(entries)) {
    const v = entries[k];
    if (!Array.isArray(v)) continue;
    // Defensive copy + filter to keep the bucket shape clean even if a
    // tampered cache snuck in non-strings.
    const cleaned = [];
    for (const id of v) {
      if (typeof id === "string" && id.length > 0) cleaned.push(id);
    }
    map.set(k, cleaned);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Rebuild the entity index from the ledger. Optionally persist the result to
 * the cache file at `cachePath`.
 *
 * @param {object} opts
 * @param {string} opts.ledgerPath — absolute path to memory.jsonl
 * @param {string} [opts.cachePath] — when provided, the rebuilt index is
 *        written to disk via `persistIndex` before this function returns.
 * @param {number} [opts.maxLineBytes] — per-line cap forwarded to
 *        streamLedgerLines (default 8 MiB there). Injectable so tests can
 *        prove the B1c3 skipped-row gate without huge fixtures.
 * @returns {Promise<{
 *   entitiesByCanonicalId: Map<string, string[]>,
 *   ledgerMtime: number,
 *   built_at: string,
 * }>}
 */
export async function rebuildEntityIndex({ ledgerPath, cachePath, maxLineBytes } = {}) {
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) {
    throw new TypeError("rebuildEntityIndex: ledgerPath required");
  }
  const entitiesByCanonicalId = streamLedgerIntoIndex(ledgerPath, { maxLineBytes });
  // Read the mtime AFTER the ledger read so the recorded fingerprint reflects
  // the state we actually consumed. Missing ledger → 0 (cold start).
  const ledgerMtime = statLedgerMtime(ledgerPath) ?? 0;
  const built_at = new Date().toISOString();
  const index = { entitiesByCanonicalId, ledgerMtime, built_at };

  if (typeof cachePath === "string" && cachePath.length > 0) {
    await persistIndex(index, cachePath);
  }
  return index;
}

/**
 * Load the entity index from the cache file if it is consistent with the
 * ledger's current mtime; otherwise rebuild from the ledger (and persist when
 * a cachePath is provided).
 *
 * "Consistent" means: (a) the cache file exists and parses as JSON, (b) the
 * schema version matches, and (c) the recorded `ledger_mtime_ms` equals the
 * ledger's current `mtimeMs`. Any divergence → full rebuild.
 *
 * @param {object} opts
 * @param {string} opts.ledgerPath
 * @param {string} [opts.cachePath]
 * @returns {Promise<{
 *   entitiesByCanonicalId: Map<string, string[]>,
 *   ledgerMtime: number,
 *   built_at: string,
 * }>}
 */
export async function loadOrRebuildIndex({ ledgerPath, cachePath } = {}) {
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) {
    throw new TypeError("loadOrRebuildIndex: ledgerPath required");
  }

  // WU-incrementalize-recall-recomputes — the module-scope append-aware cache
  // is the WARM path: on the common daemon-append case it tail-merges ONLY the
  // appended ledger bytes into the cached entity buckets instead of re-streaming
  // the whole 1.82 GB file. Determinism is preserved: entity buckets are
  // append-only ADD (pushEntry), and the tail rows are applied in ledger order
  // after the cached prefix, so the result is byte-identical to a full rebuild.
  // The disk cache remains a COLD-START seed (used by the fullRebuild callback)
  // so a fresh process skips the catastrophic 153 s cold full scan.
  let coldRebuilt = null;
  let lastBuiltAt = null;
  // C1: read the gate ONCE per CALL (never at module load) and use that single
  // reading for the seed, the resume offset and the persist below, so one call
  // can never straddle a flag flip.
  const checkpointCacheOn = _checkpointCacheEnabled();

  const struct = appendAwareLedgerProjection({
    ledgerPath,
    namespace: ENTITY_INDEX_PROJECTION_NS,
    makeEmpty: () => ({ entitiesByCanonicalId: new Map() }),
    applyParsedRow: (s, row) => {
      applyRow(s.entitiesByCanonicalId, row);
    },
    fullRebuild: (lp) => {
      const seeded = _coldSeedEntityIndex(lp, cachePath);
      coldRebuilt = seeded;
      // C1 — REPORT EXACT COVERAGE. The legacy bare-struct return makes
      // _unwrapRebuildResult record resumeOffset null, and the projection then
      // records safeOffset = the raw file size (append-aware-ledger-projection
      // .js:361-365). That is sound ONLY when the seed provably covered every
      // byte of the file it saw — true for the mtime-equality seed, FALSE under
      // checkpoint acceptance, where the seed covers exactly [0, checkpoint.eof)
      // and the file may carry a torn tail (or fresh appends) beyond it. A
      // raw-size resume would restart the next tail-merge PAST — or mid-row
      // inside — those bytes and skip them permanently. Report cp.eof instead,
      // exactly as derivation-graph.js:658-664 does. A degraded/streamed seed
      // with no checkpoint keeps the historical bare shape.
      const projectionStruct = {
        entitiesByCanonicalId: seeded.entitiesByCanonicalId,
      };
      // H3 — keep the last certified coverage beside the warm projection. It
      // is deliberately internal (the public return below still exposes only
      // entitiesByCanonicalId / ledgerMtime / built_at) and exists only while
      // the checkpoint flag is on, preserving the flag-off struct shape.
      if (checkpointCacheOn && seeded.checkpoint != null) {
        projectionStruct.checkpoint = seeded.checkpoint;
      }
      if (
        checkpointCacheOn &&
        seeded.checkpoint != null &&
        Number.isSafeInteger(seeded.checkpoint.eof)
      ) {
        return {
          struct: projectionStruct,
          resumeOffset: seeded.checkpoint.eof,
        };
      }
      return projectionStruct;
    },
    onChanged: (s, branch, coverage) => {
      // Refresh the disk cache whenever the projection materially changed
      // (cold rebuild OR append-growth tail-merge), EXCEPT when the cold seed
      // came from an already-consistent disk cache (no rewrite needed). This
      // (a) keeps an exact-hit recall off disk and (b) ensures
      // entity-index.cache.json reflects the current ledger so a cold process
      // skips the 153 s rebuild (grounding-plan part-1). Entity-index is the
      // fallback-gated branch (rare), so a persist on growth is not a hot-path
      // concern. Non-fatal on failure.
      if (branch === "cold" && coldRebuilt != null && coldRebuilt._fromDiskCache === true) {
        return;
      }
      if (typeof cachePath !== "string" || cachePath.length === 0) return;
      // C1/H3 — UNDER-CLAIM, NEVER OVER-CLAIM: on a cold build, stamp the
      // checkpoint pinned by the seed. On warm growth, H3 may advance it only
      // to the projection's exact reported coverage below.
      let cpForPersist =
        checkpointCacheOn && coldRebuilt != null && coldRebuilt.checkpoint != null
          ? coldRebuilt.checkpoint
          : null;
      // H3 — a warm grow has no cold-seed-local checkpoint, but the shared
      // projection now reports the exact newline-safe offset it just folded.
      // Extend the witness already carried by the warm struct, and publish
      // only when the captured eof equals that coverage. If another append
      // lands between the tail merge and capture, newCp.eof is larger and we
      // deliberately skip this write: persisting the entries with that newer
      // checkpoint would over-claim rows the Map does not contain. The next
      // warm call folds them and retries. A discontinuous prefix likewise
      // fails closed instead of laundering a boundary-only grow decision into
      // a durable witness.
      if (branch === "grow" && checkpointCacheOn) {
        const safeOffset = coverage && coverage.safeOffset;
        const prevCp = s.checkpoint;
        const newCp = captureCheckpoint(
          ledgerPath,
          prevCp == null ? undefined : { prev: prevCp },
        );
        const continuityOk =
          prevCp == null ||
          (newCp != null &&
            (witnessExtends(prevCp, newCp) || newCp.prefixVerified === true));
        if (
          newCp == null ||
          !Number.isSafeInteger(safeOffset) ||
          newCp.eof !== safeOffset ||
          !continuityOk
        ) {
          return;
        }
        cpForPersist = newCp;
        s.checkpoint = newCp;
      }
      const mtimeForPersist =
        checkpointCacheOn && cpForPersist != null &&
        typeof cpForPersist.mtimeMs === "number"
          ? cpForPersist.mtimeMs
          : statLedgerMtime(ledgerPath) ?? 0;
      lastBuiltAt = new Date().toISOString();
      try {
        _persistIndexSync(
          {
            entitiesByCanonicalId: s.entitiesByCanonicalId,
            ledgerMtime: mtimeForPersist,
            built_at: lastBuiltAt,
            checkpoint: cpForPersist,
          },
          cachePath,
        );
      } catch {
        // Cache write failure is non-fatal — the in-memory index is still valid.
      }
    },
  });

  const currentMtime = statLedgerMtime(ledgerPath);
  if (struct == null) {
    // Defensive: should not happen (fullRebuild always returns a struct).
    return rebuildEntityIndex({ ledgerPath, cachePath });
  }

  const ledgerMtime =
    coldRebuilt != null && coldRebuilt._fromDiskCache === true &&
    typeof coldRebuilt.ledgerMtime === "number"
      ? coldRebuilt.ledgerMtime
      : currentMtime ?? 0;
  const built_at =
    lastBuiltAt != null
      ? lastBuiltAt
      : coldRebuilt != null && typeof coldRebuilt.built_at === "string"
        ? coldRebuilt.built_at
        : new Date().toISOString();

  return {
    entitiesByCanonicalId: struct.entitiesByCanonicalId,
    ledgerMtime,
    built_at,
  };
}

/**
 * Cold-start seed for the entity index: prefer a consistent on-disk cache (so a
 * fresh process skips the catastrophic 153 s full scan), else stream the
 * ledger. Returns { entitiesByCanonicalId, ledgerMtime, built_at,
 * _fromDiskCache? }. Invoked by appendAwareLedgerProjection's fullRebuild branch
 * on the cold / shrink / mtime-regression case ONLY — never on the warm path.
 */
function _coldSeedEntityIndex(ledgerPath, cachePath) {
  // NOTE (fail-closed contract, B1c3): statLedgerMtime stays the mtime path.
  // It returns null ONLY on ENOENT and THROWS on every other errno
  // (test/synthesis/entity-index-fail-closed.test.mjs leg (d)); captureCheckpoint
  // swallows those to null by design, so routing the mtime through it would
  // silently degrade an unreadable ledger into a "cold start".
  const currentMtime = statLedgerMtime(ledgerPath);
  // C1 (default OFF) — checkpoint-validated seed. Everything below this branch
  // is the pre-C1 body, byte-identical.
  if (_checkpointCacheEnabled()) {
    return _coldSeedEntityIndexCheckpointed(ledgerPath, cachePath, currentMtime);
  }
  if (typeof cachePath === "string" && cachePath.length > 0 && existsSync(cachePath)) {
    try {
      const raw = readFileSync(cachePath, "utf8");
      const parsed = JSON.parse(raw);
      const schemaOk = parsed && parsed.schema_version === ENTITY_INDEX_SCHEMA_VERSION;
      const mtimeOk =
        currentMtime != null && parsed && parsed.ledger_mtime_ms === currentMtime;
      const coldStartOk =
        currentMtime == null && parsed && parsed.ledger_mtime_ms === 0;
      if (schemaOk && (mtimeOk || coldStartOk)) {
        return {
          entitiesByCanonicalId: deserializeEntries(parsed.entries),
          ledgerMtime: parsed.ledger_mtime_ms,
          built_at: typeof parsed.built_at === "string"
            ? parsed.built_at
            : new Date().toISOString(),
          _fromDiskCache: true,
        };
      }
    } catch {
      // Corrupt cache → fall through to stream rebuild.
    }
  }
  const entitiesByCanonicalId = streamLedgerIntoIndex(ledgerPath);
  return {
    entitiesByCanonicalId,
    ledgerMtime: currentMtime ?? 0,
    built_at: new Date().toISOString(),
  };
}

/**
 * C1 — checkpoint-validated cold seed (ENTITY_INDEX_CHECKPOINT_CACHE only).
 *
 * Branch-for-branch mirror of content-index.js:476-637, with its reason
 * strings ("no-cache", "cache-corrupt", "schema-migration",
 * "invalid-checkpoint", "checkpoint-discontinuity", "missing",
 * "delta-read-*"):
 *
 *   1. read + parse the cache; check schema; deserializeCheckpoint(parsed
 *      .checkpoint). A null at any step is exactly ONE full rebuild, which
 *      then stamps a checkpoint (legacy-v1 self-migration).
 *   2. PIN FIRST — captureCheckpoint(ledgerPath, { prev: cachedCp }) BEFORE a
 *      single delta byte is read. Its internal verifyPrefix is the one
 *      O(witness) prefix verification per load (<= 128 x 64 KiB, never the
 *      whole 2.9 GB file). Rows appended after the pin sit beyond newCp.eof:
 *      not folded, not certified, folded exactly once on a later load.
 *   3. Capture failure over a PRESENT ledger (EACCES / transient I/O) is
 *      FAIL-STATIC: serve the cached entries read-only and do NOT persist.
 *      Rebuilding here would capture null again and clobber a populated cache
 *      with an empty one on every tick (content-index.js:517-536).
 *   4. Missing ledger + origin cursor (cachedCp.eof === 0) is an exact hit —
 *      the checkpoint-era equivalent of the pre-C1 `coldStartOk` acceptance,
 *      and like it the cache file is NOT rewritten on every cold tick.
 *   5. Continuity gate: accept when witnessExtends(cachedCp, newCp) OR
 *      newCp.prefixVerified === true. The second is a witness-cap-overflow
 *      RESAMPLE whose prefix verified byte-identical inside the capture call
 *      (ledger-checkpoint.js:292-308) — treating it as a discontinuity is what
 *      forced a full rebuild every ~63 updates. Genuine discontinuity
 *      (shrink / prefix drift / atomic replacement) still fails closed.
 *   6. Fold exactly [cachedCp.eof, newCp.eof) through the same applyRow
 *      reducer, so the returned index covers [0, newCp.eof) — the value
 *      reported as resumeOffset by the fullRebuild callback.
 *
 * Returns the same shape as _coldSeedEntityIndex plus `checkpoint` (the
 * EXACT coverage of `entitiesByCanonicalId`, or absent when the seed fell back
 * to the tolerant stream, which certifies nothing). `_fromDiskCache: true`
 * marks the no-rewrite outcomes. `_mode` / `_reason` carry content-index's
 * stats.mode / stats.reason vocabulary for diagnostics; no control flow reads
 * them (the caller branches on `_fromDiskCache` and `checkpoint` only).
 */
function _coldSeedEntityIndexCheckpointed(ledgerPath, cachePath, currentMtime) {
  // Full rebuild, pin-first so the persisted payload carries an EXACT-coverage
  // checkpoint (without one the next cold process pays the full re-stream
  // forever). The tolerant-stream fallback certifies nothing and stamps no
  // checkpoint — and it is also the B1c3 fail-closed gate: it THROWS on an
  // unreadable ledger and on a dropped oversized row, and yields an empty
  // index only for a genuinely missing (ENOENT) ledger.
  const fullRebuild = (reason) => {
    const cp = captureCheckpoint(ledgerPath);
    if (cp !== null) {
      const entitiesByCanonicalId = new Map();
      const { error } = _foldEntityRows(
        ledgerPath,
        emptyCheckpoint(),
        cp,
        entitiesByCanonicalId,
      );
      if (error === null) {
        return {
          entitiesByCanonicalId,
          ledgerMtime: currentMtime ?? 0,
          built_at: new Date().toISOString(),
          checkpoint: cp,
          _mode: "full-rebuild",
          _reason: reason,
        };
      }
      // A delta we could not read cleanly certifies nothing: discard the
      // partial fold and fall through to the tolerant stream below.
    }
    return {
      entitiesByCanonicalId: streamLedgerIntoIndex(ledgerPath),
      ledgerMtime: currentMtime ?? 0,
      built_at: new Date().toISOString(),
      _mode: "full-rebuild-streamed",
      _reason: reason,
    };
  };

  if (!(typeof cachePath === "string" && cachePath.length > 0) || !existsSync(cachePath)) {
    return fullRebuild("no-cache");
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {
    // Corrupt cache → rebuild. The cache is a derived projection and is NEVER
    // deleted or truncated here; the rebuild simply overwrites it atomically.
    return fullRebuild("cache-corrupt");
  }
  if (parsed == null || parsed.schema_version !== ENTITY_INDEX_SCHEMA_VERSION) {
    return fullRebuild("schema-migration");
  }
  const cachedCp = deserializeCheckpoint(parsed.checkpoint);
  if (cachedCp === null) {
    // Legacy v1 payload (mtime-only, no `checkpoint` key) or a malformed one:
    // one full rebuild migrates it forward.
    return fullRebuild("invalid-checkpoint");
  }
  const cachedBuiltAt =
    typeof parsed.built_at === "string" ? parsed.built_at : new Date().toISOString();

  // PIN FIRST — before any delta byte is read.
  const newCp = captureCheckpoint(ledgerPath, { prev: cachedCp });
  if (newCp === null) {
    if (existsSync(ledgerPath)) {
      // Present-but-unreadable ledger: serve the CACHED index read-only and
      // persist NOTHING (fail-static). Self-heals on the next readable tick.
      return {
        entitiesByCanonicalId: deserializeEntries(parsed.entries),
        ledgerMtime: currentMtime ?? 0,
        built_at: cachedBuiltAt,
        checkpoint: cachedCp,
        _fromDiskCache: true,
        _mode: "cache-stale-capture-failed",
      };
    }
    if (cachedCp.eof === 0) {
      // Missing ledger + origin cursor: exact hit, no rewrite (preserves the
      // pre-C1 ledger_mtime_ms === 0 cold-start acceptance).
      return {
        entitiesByCanonicalId: deserializeEntries(parsed.entries),
        ledgerMtime: currentMtime ?? 0,
        built_at: cachedBuiltAt,
        checkpoint: cachedCp,
        _fromDiskCache: true,
        _mode: "cache-hit-exact",
      };
    }
    return fullRebuild("missing");
  }

  // Continuity gate (fail closed). prefixVerified is CONTINUITY, never a
  // rebuild trigger — see the docblock and memperf FINDINGS.md:32.
  if (!witnessExtends(cachedCp, newCp) && newCp.prefixVerified !== true) {
    return fullRebuild("checkpoint-discontinuity");
  }

  if (newCp.eof === cachedCp.eof) {
    // Exact hit: zero delta rows, zero disk writes.
    return {
      entitiesByCanonicalId: deserializeEntries(parsed.entries),
      ledgerMtime: currentMtime ?? 0,
      built_at: cachedBuiltAt,
      checkpoint: cachedCp,
      _fromDiskCache: true,
      _mode: "cache-hit-exact",
    };
  }

  // Incremental: cached entries pre-populate the buckets, then ONLY
  // [cachedCp.eof, newCp.eof) is folded on top in ledger order — identical to
  // what a full rebuild would produce (pushEntry is an append-only, dedup'd
  // ADD).
  const entitiesByCanonicalId = deserializeEntries(parsed.entries);
  const { rows, error } = _foldEntityRows(
    ledgerPath,
    cachedCp,
    newCp,
    entitiesByCanonicalId,
  );
  if (error !== null) {
    return fullRebuild(`delta-read-${error}`);
  }
  return {
    entitiesByCanonicalId,
    ledgerMtime: currentMtime ?? 0,
    built_at: new Date().toISOString(),
    checkpoint: newCp,
    _mode: "incremental",
    _rowsFolded: rows,
  };
}

/**
 * Lookup the memory_ids that mention the given canonical_id.
 * Returns an empty array for unknown canonical_ids (never throws on a miss).
 *
 * @param {{entitiesByCanonicalId: Map<string, string[]>}} index
 * @param {string} canonicalId
 * @returns {string[]}
 */
export function lookupByEntity(index, canonicalId) {
  if (index == null || !(index.entitiesByCanonicalId instanceof Map)) {
    throw new TypeError("lookupByEntity: index missing entitiesByCanonicalId Map");
  }
  if (typeof canonicalId !== "string" || canonicalId.length === 0) return [];
  const bucket = index.entitiesByCanonicalId.get(canonicalId);
  // Defensive copy — callers should not mutate the in-memory cache.
  return bucket === undefined ? [] : bucket.slice();
}

/**
 * C4 — SOURCE-AGNOSTIC lookup: the memory_ids that mention the given
 * canonical_id under ANY source, resolved through the same entityMatchKey()
 * the scorer uses, so lookup and scoring agree about identity.
 *
 * Contract is lookupByEntity's, verbatim:
 *   - TypeError on a malformed index (no entitiesByCanonicalId Map);
 *   - [] for a non-string / empty id and for an unknown key (never throws on a
 *     miss);
 *   - a defensive .slice() so callers cannot mutate the in-memory cache.
 *
 * FLAG-GATED, DEFAULT OFF (MEMORY_RECALL_ENTITY_MATCHKEY_LOOKUP=1). With the
 * flag unset this DELEGATES to lookupByEntity — byte-identical results, and no
 * derived map is constructed.
 *
 * Order: first occurrence in source-Map (ledger) order, deduped across the
 * source buckets that collapse onto one key. See _deriveMatchKeyMap.
 *
 * NOT WIRED — ordering hazard for the wiring node. The candidate-selection
 * loop at recall.js:2050-2075 takes a prefix bounded by
 * RECALL_SUBSTRATE_FALLBACK_MAX_CANDIDATES (validation.js:166 = 50). The
 * largest bucket this function can return is a single person bucket
 * (e.g. person:alex_example_com) holding hundreds of thousands of ids
 * (single-source git-log, but 100% new reach because recall.js:1438
 * hardcodes source=chat-claude-code), and 1,458 match-key buckets exceed the
 * cap. In ledger order, a naive first-50 take would hand recall the 50 OLDEST
 * rows. Pick a recency- or score-ordered take before flipping the flag in
 * production.
 *
 * @param {{entitiesByCanonicalId: Map<string, string[]>}} index
 * @param {string} canonicalId
 * @returns {string[]}
 */
export function lookupByEntityMatchKey(index, canonicalId) {
  if (index == null || !(index.entitiesByCanonicalId instanceof Map)) {
    throw new TypeError(
      "lookupByEntityMatchKey: index missing entitiesByCanonicalId Map",
    );
  }
  if (typeof canonicalId !== "string" || canonicalId.length === 0) return [];
  // Flag OFF — exact-key behavior, reusing the one implementation of it.
  if (!_matchKeyLookupEnabled()) return lookupByEntity(index, canonicalId);
  const key = entityMatchKey(canonicalId);
  if (key === null) return [];
  const source = index.entitiesByCanonicalId;
  let derived = _matchKeyMemo.get(source);
  if (derived === undefined) {
    derived = _deriveMatchKeyMap(source);
    _matchKeyMemo.set(source, derived);
  }
  const bucket = derived.get(key);
  // Defensive copy — callers should not mutate the derived map.
  return bucket === undefined ? [] : bucket.slice();
}

/**
 * Add a single ledger row's worth of entities to the in-memory index.
 * Useful for incremental updates from the cascade-stamper at promote time;
 * does NOT touch the cache file.
 *
 * Tolerant of:
 *   - empty / missing entities array (no-op)
 *   - malformed entity entries (skipped individually)
 *
 * @param {{entitiesByCanonicalId: Map<string, string[]>}} index
 * @param {string} memoryId
 * @param {Array<{canonical_id?: string}>} entities
 * @returns {void}
 */
export function addToIndex(index, memoryId, entities) {
  if (index == null || !(index.entitiesByCanonicalId instanceof Map)) {
    throw new TypeError("addToIndex: index missing entitiesByCanonicalId Map");
  }
  if (typeof memoryId !== "string" || memoryId.length === 0) return;
  if (!Array.isArray(entities) || entities.length === 0) return;
  for (const e of entities) {
    if (e == null || typeof e !== "object") continue;
    const canonicalId = e.canonical_id;
    if (typeof canonicalId !== "string" || canonicalId.length === 0) continue;
    pushEntry(index.entitiesByCanonicalId, canonicalId, memoryId);
  }
  // W3: pushEntry invalidates at the shared mutation point, covering this path
  // and loadOrRebuildIndex's in-place warm tail-merge with one discipline.
}

/**
 * Persist the index to a cache file at `cachePath`.
 *
 * Write discipline:
 *   - tmp file + rename so a torn write never replaces a good cache file.
 *   - mode 0o600 on the tmp file (and inherited by rename) — operator-only
 *     readable, matching the architecture.md file mode convention for
 *     derived caches under MEMORY_ROOT.
 *
 * @param {{entitiesByCanonicalId: Map<string, string[]>, ledgerMtime: number, built_at: string}} index
 * @param {string} cachePath — absolute path to the cache file
 * @returns {Promise<void>}
 */
export async function persistIndex(index, cachePath) {
  _persistIndexSync(index, cachePath);
}

/**
 * Synchronous core of persistIndex — used by the append-aware onChanged
 * callback (which is sync) to refresh the disk cache on a cold rebuild OR an
 * append-growth tail-merge. Same write discipline (tmp + rename, mode 0600).
 * Throws on invalid args (the async wrapper preserves the historical contract).
 */
function _persistIndexSync(index, cachePath) {
  if (index == null || !(index.entitiesByCanonicalId instanceof Map)) {
    throw new TypeError("persistIndex: index missing entitiesByCanonicalId Map");
  }
  if (typeof cachePath !== "string" || cachePath.length === 0) {
    throw new TypeError("persistIndex: cachePath required");
  }

  const payload = {
    schema_version: ENTITY_INDEX_SCHEMA_VERSION,
    ledger_mtime_ms: typeof index.ledgerMtime === "number" ? index.ledgerMtime : 0,
    entries: serializeEntries(index.entitiesByCanonicalId),
    built_at: typeof index.built_at === "string" ? index.built_at : new Date().toISOString(),
  };
  // C1 — ADDITIVE `checkpoint`, flag-gated. `ledger_mtime_ms` above keeps
  // being written unconditionally as an ADVISORY field (diagnostics + the
  // flag-OFF validity test); under the flag validity is decided by the
  // witness, never by that equality. With the flag unset no key is added and
  // the persisted bytes are identical to the pre-C1 tree. serializeCheckpoint
  // validates and deep-copies; a null (absent/invalid checkpoint — e.g. a
  // tolerant-stream rebuild, which certifies nothing) writes no key at all,
  // so the next cold seed re-validates from scratch rather than trusting an
  // unbacked claim.
  if (_checkpointCacheEnabled()) {
    const cp = serializeCheckpoint(index.checkpoint);
    if (cp !== null) payload.checkpoint = cp;
  }

  const tmpPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
  const bytes = JSON.stringify(payload);
  writeFileSync(tmpPath, bytes, { mode: 0o600 });
  renameSync(tmpPath, cachePath);
}

// Test-only: clear the module-scope append-aware projection cache so a fixture
// rebuild starts cold. Production code MUST NOT call this. Mirrors the
// _resetOffsetCaches discipline in ledger-offset-index.js.
export { _resetAppendAwareProjectionCache as _resetEntityIndexCache } from "./append-aware-ledger-projection.js";

// Exported for tests that must exercise internals directly (mirrors the
// __internal export precedent in time-index.js). statLedgerMtime's B1c3
// ENOENT-vs-other-errno separation is only reachable through the public
// surface behind the readError gate, so the fail-closed suite pins it here.
export const __internal = Object.freeze({
  statLedgerMtime,
  // C4/W3 test hooks. matchKeyDeriveCount() proves memo reuse/re-derivation and
  // the flag-OFF zero-build contract. Production invalidation lives directly
  // in pushEntry; this hook shares its fail-loud target validation.
  matchKeyDeriveCount: () => _matchKeyDeriveCount,
  invalidateMatchKeyMemo: (index) => {
    if (index == null || !(index.entitiesByCanonicalId instanceof Map)) {
      throw new TypeError(
        "invalidateMatchKeyMemo: index missing entitiesByCanonicalId Map",
      );
    }
    _invalidateMatchKeyMemoForMap(index.entitiesByCanonicalId);
  },
});
