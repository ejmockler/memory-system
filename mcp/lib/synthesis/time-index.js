// time-index.js — substrate-tier sorted index over absolute time anchors
// extracted from ledger rows' `features.time_anchors[]`.
//
// Implements F-SYN-SUBSTRATE-TIME-INDEX. Honors:
//   - docs/specs/synthesis/time-anchor-schema.md (anchor shape: kind /
//     instant_iso / duration_ms / raw_phrase emitted by the resolver, and the
//     foundation schema's parsed.iso baked at promote time for event_ts-
//     anchored relative phrases).
//   - docs/specs/synthesis/power-law-decay-contract.md (this index owns the
//     bucketed `w_t1 * time_anchor_match` channel ONLY; the orthogonal
//     `w_t2 * power_law_decay` channel reads `event.ts`, not anchors, and is
//     never computed here).
//
// SCOPE at v0:
//   - Sorted-array structure over absolute instants. Binary search for range +
//     two-finger walk for nearest-neighbor (per spec implementation hints).
//   - Rebuild-from-ledger discipline mirroring entity-index: mtime+size
//     fingerprint, stale check, full rebuild on miss.
//   - Recurring anchors (instant_iso=null) are NOT indexed in the sorted
//     structure. The substrate node leaves recurring expansion to v1.
//
// SURFACE (per the WU prompt — a thinner functional API than the spec's class
// sketch; the spec sketch maps onto this with `lookupRange` ≈ queryTimeRange
// and `lookupNearest` ≈ queryProximity):
//
//   rebuildTimeIndex({ledgerPath, cachePath?})
//       → {schema_version, ledger_mtime_ms, ledger_size,
//          byMemoryId: Map<string, Array<{instant_iso, kind}>>,
//          sortedByInstant: Array<{memory_id, instant_iso, kind}>,
//          built_at}
//   loadOrRebuildTimeIndex({ledgerPath, cachePath?})
//   queryTimeRange(index, {start_iso, end_iso, kinds?})
//       → Array<memory_id>  (de-duplicated, sorted asc by memory_id)
//   queryProximity(index, {target_iso, window_ms?, max_results?})
//       → Array<{memory_id, distance_ms, anchor_kind}>
//   persistTimeIndex(index, cachePath)
//
// DETERMINISM:
//   Pure function of ledger state. The sorted array is stable: ascending by
//   instant_ms, ties broken by memory_id ASC, then by anchor kind ASC. The
//   schema/version field is bumped on any change to the sort key contract.
//
// LOCK DISCIPLINE:
//   Cache writes are non-atomic at v0 (write+rename). Concurrent rebuild from
//   two processes is benign — the worst case is the loser's bytes are
//   overwritten; the deterministic content guarantees the bytes match.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { streamLedgerLines } from "./_ledger-stream.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cache schema version. Bumps on changes to the sort-key contract or to
 *  the on-disk shape. The loader refuses to consume a mismatched version
 *  (forces rebuild) so replay across version bumps is byte-stable. */
export const TIME_INDEX_VERSION = "v1";

/** Anchor kinds (mirrors time-anchor-resolver.js / time-anchor-schema.md). */
export const TIME_ANCHOR_KINDS = Object.freeze([
  "absolute",
  "relative",
  "recurring",
]);

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** Frozen bucket thresholds — read by the multi-feature score's
 *  time_anchor_match channel when this index serves the bucketed lookup. */
export const TIME_BUCKET_THRESHOLDS_MS = Object.freeze({
  hour: MS_PER_HOUR,
  day: MS_PER_DAY,
  week: 7 * MS_PER_DAY,
  month: 30 * MS_PER_DAY,
  year: 365 * MS_PER_DAY,
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Parse an ISO-8601 string into a finite epoch-ms number or NaN. Defensive
 *  about malformed inputs; `rebuildTimeIndex` filters NaN entries. */
function parseIsoMs(iso) {
  if (typeof iso !== "string" || iso.length === 0) return NaN;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : NaN;
}

/** Stat fingerprint over (mtime_ms, size). Mirrors the discipline in
 *  recall/index-cache.js. Returns `null` ONLY when the file is absent
 *  (ENOENT) — the loader treats that as "ledger empty / no rows", not as an
 *  error. B1c2: any OTHER stat failure (parent-dir EACCES, ELOOP, ENOTDIR)
 *  means an EXISTING ledger we cannot see — conflating that with "absent"
 *  produced a (0,0)-fingerprinted EMPTY index, so it now throws (fail-closed,
 *  same shape as the B1c readError throw in rebuildTimeIndex). */
function statLedger(path) {
  try {
    const s = statSync(path);
    return { mtime_ms: s.mtimeMs, size: s.size };
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw new Error(
      `time-index: ledger stat failed (fail-closed, B1c2): ${e && e.message ? e.message : String(e)}`,
    );
  }
}

/** Lower bound binary search: returns first idx where pred(sorted[idx]) is
 *  true; len if no such idx. `pred` must be monotone (false…true). */
function binarySearch(sorted, pred) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (pred(sorted[mid])) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Stable comparator on (instant_ms ASC, memory_id ASC, kind ASC). The
 *  multi-key tie-break is what makes the sorted array reproducible across
 *  rebuilds; cache replay relies on it. */
function compareSortedEntry(a, b) {
  if (a.instant_ms !== b.instant_ms) return a.instant_ms - b.instant_ms;
  if (a.memory_id !== b.memory_id) return a.memory_id < b.memory_id ? -1 : 1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return 0;
}

/** Iterate a row's `features.time_anchors[]` and yield (instant_iso, kind)
 *  pairs for the absolute / instant-bearing entries. Recurring anchors and
 *  malformed entries are silently skipped (per spec error-modes section). */
function* extractAnchorInstants(row) {
  if (row == null || typeof row !== "object") return;
  const features = row.features;
  if (features == null || typeof features !== "object") return;
  const anchors = features.time_anchors;
  if (!Array.isArray(anchors)) return;
  for (const a of anchors) {
    if (a == null || typeof a !== "object") continue;
    const kind = typeof a.kind === "string" ? a.kind : null;
    if (kind === null || !TIME_ANCHOR_KINDS.includes(kind)) continue;
    // Two shapes are tolerated here. The resolver substrate emits
    //   { kind, instant_iso, duration_ms, raw_phrase, span, confidence }
    // (a v0 simplified view). The foundation schema (time-anchor-schema.md)
    // emits the discriminated-union shape with parsed.iso. We support both.
    let instant_iso = null;
    if (typeof a.instant_iso === "string" && a.instant_iso.length > 0) {
      instant_iso = a.instant_iso;
    } else if (
      a.parsed != null
      && typeof a.parsed === "object"
      && typeof a.parsed.iso === "string"
      && a.parsed.iso.length > 0
    ) {
      instant_iso = a.parsed.iso;
    }
    if (instant_iso === null) continue;            // recurring or null instant
    const ms = parseIsoMs(instant_iso);
    if (!Number.isFinite(ms)) continue;            // malformed → skip
    yield { instant_iso, kind, instant_ms: ms };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Rebuild the time-index from a JSONL ledger.
 *
 * For every ledger row that carries `features.time_anchors[]`, each anchor
 * with a resolvable absolute instant contributes one entry to the sorted
 * structure and one entry to the per-memory map.
 *
 * @param {object} opts
 * @param {string} opts.ledgerPath - path to the JSONL memory ledger
 * @param {string} [opts.cachePath] - reserved for callers wanting to know the
 *                                     cache destination; the function does
 *                                     NOT write cache here (call
 *                                     persistTimeIndex for that).
 * @param {number} [opts.maxLineBytes] - per-line cap forwarded to
 *                                     streamLedgerLines (default 8 MiB
 *                                     there). Injectable so tests can prove
 *                                     the skipped-row gate without huge
 *                                     fixtures.
 * @returns {Promise<{
 *   schema_version: string,
 *   ledger_path: string,
 *   ledger_mtime_ms: number,
 *   ledger_size: number,
 *   byMemoryId: Map<string, Array<{instant_iso: string, kind: string}>>,
 *   sortedByInstant: Array<{memory_id: string, instant_iso: string, kind: string}>,
 *   built_at: string,
 * }>}
 */
export async function rebuildTimeIndex({ ledgerPath, cachePath, maxLineBytes } = {}) {
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) {
    throw new TypeError("rebuildTimeIndex: ledgerPath is required");
  }
  void cachePath; // surface accepted for caller symmetry; not used here

  const stat = statLedger(ledgerPath);
  const ledger_mtime_ms = stat == null ? 0 : stat.mtime_ms;
  const ledger_size = stat == null ? 0 : stat.size;

  // Stage rows into a flat array with instant_ms attached so we can sort
  // once. Each row may contribute multiple entries (multi-anchor events).
  /** @type {Array<{instant_ms: number, instant_iso: string, memory_id: string, kind: string}>} */
  const staged = [];

  // Stream line-by-line via _ledger-stream.js (RR2c precedent: the identical
  // readFileSync-the-whole-ledger pattern was replaced in entity-index.js:147
  // after ERR_STRING_TOO_LONG on the >512MB live ledger). Malformed lines are
  // skipped by the streamer; the row-shape guards below mirror the deleted
  // readLedgerRows generator exactly.
  // B1c2 accepted tradeoff: the streamer's default 8 MiB maxLineBytes is far
  // above any legal row (put.js caps content at CONTENT_MAX_CHARS=16384,
  // validation.js:18), and if features/embeddings ever bloat a row past the
  // cap the skipped>0 gate below makes the drop LOUD instead of silent.
  const counts = streamLedgerLines(ledgerPath, (row) => {
    if (row == null || typeof row !== "object") return;
    if (typeof row.id !== "string" || row.id.length === 0) return;
    const memory_id = row.id;
    for (const { instant_iso, kind, instant_ms } of extractAnchorInstants(row)) {
      staged.push({ instant_ms, instant_iso, memory_id, kind });
    }
  }, { maxLineBytes });

  // B1c fail-closed addition (deliberately NOT copied from entity-index,
  // which ignores readError): a failed read — open failure OR mid-stream
  // I/O failure, per the _ledger-stream.js readError contract — must be
  // LOUD, before any index is projected from the truncated scan. A missing
  // ledger stays fine (readError null, zero rows → empty index). Without
  // this throw, an unreadable ledger yielded an empty index stamped with
  // the CURRENT mtime+size, which loadOrRebuildTimeIndex then persisted as
  // a fingerprint-VALID poisoned cache, and recall.js's
  // time_index_load_failed degrade reason could never fire.
  if (counts.readError !== null) {
    throw new Error(
      `rebuildTimeIndex: ledger read failed (fail-closed, B1c): ${counts.readError}`,
    );
  }

  // B1c2 fail-closed addition: the streamer counts an over-maxLineBytes line
  // in counts.skipped WITHOUT setting readError, so a valid-but-oversized row
  // would otherwise be dropped silently — yielding a fingerprint-VALID
  // PARTIAL index, the same failure shape the readError throw above kills,
  // via a different counter. Same policy: LOUD, before projection.
  if (counts.skipped > 0) {
    throw new Error(
      `rebuildTimeIndex: ${counts.skipped} ledger line(s) exceeded maxLineBytes and were dropped by the streamer — refusing to project a partial index (fail-closed, B1c2)`,
    );
  }

  staged.sort(compareSortedEntry);

  // Project the sorted entries into the two surfaces the callers consume.
  const sortedByInstant = staged.map(({ memory_id, instant_iso, kind }) => ({
    memory_id,
    instant_iso,
    kind,
  }));

  const byMemoryId = new Map();
  for (const entry of sortedByInstant) {
    const list = byMemoryId.get(entry.memory_id);
    const item = { instant_iso: entry.instant_iso, kind: entry.kind };
    if (list == null) {
      byMemoryId.set(entry.memory_id, [item]);
    } else {
      list.push(item);
    }
  }

  return {
    schema_version: TIME_INDEX_VERSION,
    ledger_path: ledgerPath,
    ledger_mtime_ms,
    ledger_size,
    byMemoryId,
    sortedByInstant,
    // Pinned to ledger_mtime_ms (not wall-clock) so two rebuilds on the
    // same ledger snapshot produce byte-identical caches.
    built_at: new Date(ledger_mtime_ms || 0).toISOString(),
  };
}

/**
 * Load a cached time-index, or rebuild if the cache is stale (or absent, or
 * version-mismatched). Stale check is mtime+size of the ledger file.
 *
 * @param {object} opts
 * @param {string} opts.ledgerPath
 * @param {string} [opts.cachePath]
 */
export async function loadOrRebuildTimeIndex({ ledgerPath, cachePath } = {}) {
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) {
    throw new TypeError("loadOrRebuildTimeIndex: ledgerPath is required");
  }
  const stat = statLedger(ledgerPath);
  const currentMtimeMs = stat == null ? 0 : stat.mtime_ms;
  const currentSize = stat == null ? 0 : stat.size;

  if (typeof cachePath === "string" && cachePath.length > 0 && existsSync(cachePath)) {
    try {
      const raw = readFileSync(cachePath, "utf8");
      const parsed = JSON.parse(raw);
      const versionOk = parsed && parsed.schema_version === TIME_INDEX_VERSION;
      const ledgerOk = parsed
        && parsed.ledger_mtime_ms === currentMtimeMs
        && parsed.ledger_size === currentSize;
      const sortedOk = Array.isArray(parsed.sorted);
      if (versionOk && ledgerOk && sortedOk) {
        return hydrateCache(parsed, ledgerPath);
      }
    } catch {
      // Corrupt cache → rebuild. Spec error-modes section says "Cache file
      // corrupt → forceRebuild".
    }
  }
  const fresh = await rebuildTimeIndex({ ledgerPath });
  if (typeof cachePath === "string" && cachePath.length > 0) {
    await persistTimeIndex(fresh, cachePath);
  }
  return fresh;
}

/** Reconstitute the live index shape from a parsed cache blob. */
function hydrateCache(parsed, ledgerPath) {
  const sortedByInstant = parsed.sorted.map((e) => ({
    memory_id: e.memory_id,
    instant_iso: e.instant_iso,
    kind: e.kind,
  }));
  const byMemoryId = new Map();
  for (const entry of sortedByInstant) {
    const list = byMemoryId.get(entry.memory_id);
    const item = { instant_iso: entry.instant_iso, kind: entry.kind };
    if (list == null) {
      byMemoryId.set(entry.memory_id, [item]);
    } else {
      list.push(item);
    }
  }
  return {
    schema_version: parsed.schema_version,
    ledger_path: ledgerPath,
    ledger_mtime_ms: parsed.ledger_mtime_ms,
    ledger_size: parsed.ledger_size,
    byMemoryId,
    sortedByInstant,
    built_at: typeof parsed.built_at === "string"
      ? parsed.built_at
      : new Date(parsed.ledger_mtime_ms || 0).toISOString(),
  };
}

/**
 * Persist a time-index to its cache file. Atomic on POSIX (write to a
 * tempfile then rename). Creates the parent directory if necessary.
 *
 * @param {{schema_version: string, ledger_mtime_ms: number, ledger_size: number,
 *          sortedByInstant: Array<{memory_id: string, instant_iso: string, kind: string}>,
 *          built_at: string}} index
 * @param {string} cachePath
 */
export async function persistTimeIndex(index, cachePath) {
  if (index == null || typeof index !== "object") {
    throw new TypeError("persistTimeIndex: index is required");
  }
  if (typeof cachePath !== "string" || cachePath.length === 0) {
    throw new TypeError("persistTimeIndex: cachePath is required");
  }
  const dir = dirname(cachePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const payload = {
    schema_version: index.schema_version,
    ledger_mtime_ms: index.ledger_mtime_ms,
    ledger_size: index.ledger_size,
    built_at: index.built_at,
    sorted: index.sortedByInstant.map((e) => ({
      memory_id: e.memory_id,
      instant_iso: e.instant_iso,
      kind: e.kind,
    })),
  };
  const tmp = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, cachePath);
}

/**
 * Range query: return the unique memory_ids whose absolute anchors fall in
 * the inclusive `[start_iso, end_iso]` window. Results sorted ascending by
 * memory_id for determinism (the operator should not see ordering depend on
 * insertion accident).
 *
 * @param {{sortedByInstant: Array<{memory_id, instant_iso, kind}>}} index
 * @param {{start_iso: string, end_iso: string, kinds?: ReadonlyArray<string>}} q
 * @returns {string[]}
 */
export function queryTimeRange(index, { start_iso, end_iso, kinds } = {}) {
  if (index == null || !Array.isArray(index.sortedByInstant)) {
    throw new TypeError("queryTimeRange: index.sortedByInstant required");
  }
  const startMs = parseIsoMs(start_iso);
  const endMs = parseIsoMs(end_iso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return [];
  }
  const kindFilter = Array.isArray(kinds) && kinds.length > 0
    ? new Set(kinds)
    : null;

  // Sorted array carries instant_iso strings only — re-parse for the
  // bounded sweep. We could carry instant_ms on the entries to avoid this,
  // but the public surface intentionally hides ms — kept as a v0 perf
  // trade-off (rebuild is the cost; queries operate over <50k entries).
  const decorated = index.sortedByInstant.map((e) => ({
    ...e,
    instant_ms: parseIsoMs(e.instant_iso),
  })).filter((e) => Number.isFinite(e.instant_ms));

  // Binary search bounds.
  const lo = binarySearch(decorated, (e) => e.instant_ms >= startMs);
  const hi = binarySearch(decorated, (e) => e.instant_ms > endMs);
  const seen = new Set();
  const out = [];
  for (let i = lo; i < hi; i++) {
    const e = decorated[i];
    if (kindFilter !== null && !kindFilter.has(e.kind)) continue;
    if (seen.has(e.memory_id)) continue;
    seen.add(e.memory_id);
    out.push(e.memory_id);
  }
  out.sort();
  return out;
}

/**
 * Proximity query: return up to `max_results` (memory_id, distance_ms,
 * anchor_kind) triples ordered by ascending distance from `target_iso`. If
 * `window_ms` is supplied (and finite & positive), candidates beyond the
 * window are dropped. Two-finger walk outward from the binary-search
 * insertion point per the spec's lookupNearest sketch.
 *
 * Tie-break across equal distances: memory_id ascending, then kind ascending.
 *
 * @param {{sortedByInstant: Array<{memory_id, instant_iso, kind}>}} index
 * @param {{target_iso: string, window_ms?: number, max_results?: number}} q
 * @returns {Array<{memory_id: string, distance_ms: number, anchor_kind: string}>}
 */
export function queryProximity(index, { target_iso, window_ms, max_results = 12 } = {}) {
  if (index == null || !Array.isArray(index.sortedByInstant)) {
    throw new TypeError("queryProximity: index.sortedByInstant required");
  }
  const targetMs = parseIsoMs(target_iso);
  if (!Number.isFinite(targetMs)) return [];
  const limit = Number.isFinite(max_results) && max_results > 0
    ? Math.floor(max_results)
    : 12;
  const windowBound = (Number.isFinite(window_ms) && window_ms > 0)
    ? window_ms
    : Infinity;

  const decorated = index.sortedByInstant.map((e) => ({
    ...e,
    instant_ms: parseIsoMs(e.instant_iso),
  })).filter((e) => Number.isFinite(e.instant_ms));
  if (decorated.length === 0) return [];

  // Two-finger walk outward from the insertion point.
  const idx = binarySearch(decorated, (e) => e.instant_ms >= targetMs);
  let l = idx - 1;
  let r = idx;
  const collected = [];
  while (collected.length < limit && (l >= 0 || r < decorated.length)) {
    const dl = l >= 0 ? targetMs - decorated[l].instant_ms : Infinity;
    const dr = r < decorated.length ? decorated[r].instant_ms - targetMs : Infinity;
    let take;
    if (dl <= dr) {
      take = { entry: decorated[l], distance_ms: dl };
      l--;
    } else {
      take = { entry: decorated[r], distance_ms: dr };
      r++;
    }
    if (take.distance_ms > windowBound) {
      // Past the window on this side. If the other side is still in range,
      // continue; otherwise terminate.
      if (l < 0 && r >= decorated.length) break;
      continue;
    }
    collected.push({
      memory_id: take.entry.memory_id,
      distance_ms: take.distance_ms,
      anchor_kind: take.entry.kind,
    });
  }
  // Final sort applies deterministic tie-break (the two-finger walk only
  // guarantees ascending distance modulo ties at exactly equal distances on
  // either side of the target).
  collected.sort((a, b) => {
    if (a.distance_ms !== b.distance_ms) return a.distance_ms - b.distance_ms;
    if (a.memory_id !== b.memory_id) return a.memory_id < b.memory_id ? -1 : 1;
    if (a.anchor_kind !== b.anchor_kind) return a.anchor_kind < b.anchor_kind ? -1 : 1;
    return 0;
  });
  return collected;
}

// Exported for tests that want to introspect internals deterministically.
export const __internal = Object.freeze({
  parseIsoMs,
  binarySearch,
  compareSortedEntry,
});
