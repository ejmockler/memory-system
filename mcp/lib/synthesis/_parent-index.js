// _parent-index.js — PIDX (incremental-aggregation, D1 keystone node).
//
// GOAL: kill the reconstruction emitter's whole-ledger byId rebuild.
//   reconstruction-emitter.js:emitReconstruction currently calls
//   scanLedgerLines(ledgerPath) on EVERY emit, materializing ALL ~1.5M parsed
//   ledger rows into a `ledgerRows` array + inline byId/reverseAdj/excise maps
//   (the measured 5.6 GB RSS cost, run every cascade tick by the aggregators).
//   This module replaces that with a PERSISTENT, in-process, incrementally
//   maintained COMPACT projection of the ledger that folds only NEW rows via
//   streamLedgerLinesWithOffset (tail-merge) — never whole rows / content.
//
// It mirrors recall/ledger-offset-index.js's cache / tail-merge / self-heal
// discipline: a module-scope cache keyed by ledger path, append-only growth is
// the common case (tail-merge only the appended bytes), and any shrink /
// mtime-regression is a self-heal full rebuild from offset 0. It parses each
// NEW row fully (unlike the offset index, which extracts only the id) to fold a
// richer projection, but the fold of every field is ROW-LOCAL (decided from a
// single row's own fields, never from cross-row state) so an incremental
// tail-merge is provably identical to a full rescan (the PIDX equivalence
// spine — design.md §D-2.1).
//
// DISCIPLINE: ESM, Node stdlib + ./_ledger-stream.js only. NEVER readFileSync
// the ledger. Defensive try/catch around every fs op; NEVER throws to the
// caller (mirrors ledger-offset-index.js).

import { closeSync, openSync, statSync } from "node:fs";
import {
  streamLedgerLinesWithOffset,
  readLedgerRowAtOffset,
} from "./_ledger-stream.js";

// ---------------------------------------------------------------------------
// Module-scope cache.
//   path -> ParentIndex = {
//     byId:             Map<id, { kind, offset, len }>,  // existence + kind + seek coords
//     exciseSeeds:      Set<id>,                          // buildExciseSeedSet semantics
//     reverseAdj:       Map<parentId, Set<childId>>,      // WIDE — buildReverseAdj edges
//     idempotencyByKey: Map<idempotency_key, id>,         // reconstructed; FIRST occurrence
//     policyIds:        Set<id>,                          // ALL policy ids, ledger order
//     size:             number,   // SAFE resume byte offset (end of last terminated line)
//     fileSize:         number,   // last-observed ledger byte size (growth/shrink fingerprint)
//     mtimeMs:          number,   // last-observed ledger mtime (growth/shrink fingerprint)
//   }
// One ledger per process in production; tests pass their hermetic path.
// ---------------------------------------------------------------------------
const _cacheByPath = new Map();

function statOf(path) {
  try {
    const s = statSync(path);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

function _newIndex() {
  return {
    byId: new Map(),
    exciseSeeds: new Set(),
    reverseAdj: new Map(),
    idempotencyByKey: new Map(),
    policyIds: new Set(),
    size: 0,
    fileSize: 0,
    mtimeMs: 0,
  };
}

// Mirror reconstruction-emitter.js:buildReverseAdj addEdge — skip empty ids and
// self-edges; append child to the parent's Set (insertion order = ledger order).
function _addEdge(reverseAdj, parentId, childId) {
  if (typeof parentId !== "string" || parentId.length === 0) return;
  if (typeof childId !== "string" || childId.length === 0) return;
  if (parentId === childId) return;
  let s = reverseAdj.get(parentId);
  if (s === undefined) {
    s = new Set();
    reverseAdj.set(parentId, s);
  }
  s.add(childId);
}

// Fold ONE parsed row into the index. Every projection below is derived ONLY
// from this row's own fields (row-local) so an incremental tail-merge equals a
// full rescan. Each rule replicates the corresponding emitter helper EXACTLY:
//   byId             — assertParentsValid/walkConsent byId (string-id rows only)
//   exciseSeeds      — buildExciseSeedSet (no id requirement on the policy row)
//   reverseAdj       — buildReverseAdj (child = row.id; three derivation kinds)
//   idempotencyByKey — checkIdempotent first-match (reconstructed, FIRST occurrence)
//   policyIds        — ALL policy row ids, ledger order
function _foldRow(index, row, offset, len) {
  if (row == null || typeof row !== "object") return;
  const id = row.id;
  const hasStringId = typeof id === "string" && id.length > 0;
  const kind = row.kind;

  // byId — existence + kind + seek coords. Latest-write-wins on id (matches
  // assertParentsValid's byId, which is last-write-wins over ledgerRows).
  if (hasStringId) {
    index.byId.set(id, { kind, offset, len });
  }

  // exciseSeeds — replicate buildExciseSeedSet EXACTLY (independent of row.id,
  // exactly as the emitter helper which never reads the policy row's own id).
  if (
    kind === "policy" &&
    row.silent !== true &&
    row.active_inline !== false &&
    row.derivation_policy !== "retain"
  ) {
    const targets = Array.isArray(row.targets) ? row.targets : [];
    for (const t of targets) {
      if (typeof t === "string" && t.length > 0) index.exciseSeeds.add(t);
    }
  }

  // reverseAdj — replicate buildReverseAdj EXACTLY (WIDE: the three derivation
  // -bearing kinds). Child is always row.id (must be a non-empty string).
  if (hasStringId) {
    if (kind === "reconstructed" && Array.isArray(row.derived_from)) {
      for (const p of row.derived_from) _addEdge(index.reverseAdj, p, id);
    } else if (kind === "fact" && Array.isArray(row.source_refs)) {
      for (const ref of row.source_refs) {
        if (ref == null || typeof ref !== "object") continue;
        const p = ref.corroboration_event_id;
        if (typeof p === "string") _addEdge(index.reverseAdj, p, id);
      }
    } else if (kind === "policy" && Array.isArray(row.targets)) {
      for (const t of row.targets) _addEdge(index.reverseAdj, t, id);
    }
  }

  // idempotencyByKey — reconstructed rows only; keep FIRST occurrence (matches
  // checkIdempotent's first-match-in-ledger-order).
  if (kind === "reconstructed" && typeof row.idempotency_key === "string") {
    if (!index.idempotencyByKey.has(row.idempotency_key)) {
      index.idempotencyByKey.set(row.idempotency_key, id);
    }
  }

  // policyIds — ledger-ordered (insertion order) set of ALL policy row ids. A
  // drift-proof SUPERSET of findAuthorityContradictions' candidate set (which
  // filters the FULL byId.values() — itself string-id-only — for active
  // exclude/fact_excluded policies).
  if (kind === "policy" && hasStringId) {
    index.policyIds.add(id);
  }
}

// Fold [startOffset, EOF) into `index` via a tail-merge stream. Returns the
// SAFE resume offset = the byte position past the last NEWLINE-TERMINATED line.
// A torn trailing line (terminated===false — the daemon mid-append) is NOT
// folded and does NOT advance the resume offset, so it is re-read on the next
// refresh once its "\n" lands (design.md §D-2.4). Never throws.
function _foldInto(index, ledgerPath, startOffset) {
  let safeOffset =
    Number.isInteger(startOffset) && startOffset >= 0 ? startOffset : 0;
  streamLedgerLinesWithOffset(
    ledgerPath,
    (text, offset, len, terminated) => {
      if (terminated !== true) return; // torn tail — skip, do not advance
      const end = offset + len + 1; // +1 for the terminating "\n"
      if (end > safeOffset) safeOffset = end;
      let row;
      try {
        row = JSON.parse(text);
      } catch {
        return; // torn/garbage line — skip (matches streamer torn-tolerance)
      }
      _foldRow(index, row, offset, len);
    },
    { startOffset: safeOffset },
  );
  return safeOffset;
}

/**
 * buildParentIndex — return a fresh-or-cached compact parent index for
 * `ledgerPath`. Mirrors ledger-offset-index.js:buildOffsetIndex.
 *
 * @param {string} ledgerPath
 * @returns {ParentIndex | null} — null ONLY if the ledger is missing.
 *
 * Behavior:
 *   - cache HIT (fileSize + mtimeMs unchanged): return cached index.
 *   - file GREW (append-only, mtime not regressed): TAIL-MERGE — fold only
 *     [safeOffset, EOF). A torn tail from a prior scan is re-read here.
 *   - cache MISS / file SHRANK / mtime regressed: full rebuild from offset 0
 *     (self-heal for truncation / compaction / restore-from-backup).
 */
export function buildParentIndex(ledgerPath) {
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) return null;
  const st = statOf(ledgerPath);
  if (st == null) return null; // missing ledger -> caller behaves as empty ledger

  const cached = _cacheByPath.get(ledgerPath);
  if (cached != null) {
    if (cached.fileSize === st.size && cached.mtimeMs === st.mtimeMs) {
      return cached; // exact fingerprint hit — nothing changed
    }
    // Append-only growth (or a torn tail that now completed — completing a
    // torn line appends the "\n", so size always grows). Tail-merge from the
    // SAFE resume offset (cached.size), re-reading any previously-torn tail.
    if (st.size > cached.fileSize && st.mtimeMs >= cached.mtimeMs) {
      try {
        cached.size = _foldInto(cached, ledgerPath, cached.size);
      } catch {
        // fall through to a full rebuild on any unexpected error
        cached.size = -1;
      }
      if (cached.size >= 0) {
        cached.fileSize = st.size;
        cached.mtimeMs = st.mtimeMs;
        return cached;
      }
    }
    // Otherwise the append-only invariant was violated (shrink / mtime
    // regression / same-size-different-mtime). Fall through to a full rebuild.
  }

  // Full rebuild from byte 0 (self-heal).
  const index = _newIndex();
  try {
    index.size = _foldInto(index, ledgerPath, 0);
  } catch {
    index.size = 0; // defensive — return whatever folded before the error
  }
  index.fileSize = st.size;
  index.mtimeMs = st.mtimeMs;
  _cacheByPath.set(ledgerPath, index);
  return index;
}

/**
 * seekRows — resolve `ids` to their FULL parsed rows by SEEKING to each row's
 * byte offset (no full ledger scan). Rows are returned in ASCENDING-OFFSET
 * (ledger) order so the caller's byId.values() reproduces the full-scan
 * iteration order the reconciliation detector depends on (design.md §D-2.5).
 *
 * @param {string} ledgerPath
 * @param {ParentIndex} index
 * @param {Set<string>|string[]} ids
 * @returns {Map<id, row>} — insertion-ordered (ledger order); ids absent from
 *   the index, or whose seeked row.id fails to match (stale offset), are
 *   omitted (a stale/wrong offset is a MISS, never a wrong row). Never throws.
 */
export function seekRows(ledgerPath, index, ids) {
  const out = new Map();
  if (index == null || !(index.byId instanceof Map)) return out;
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) return out;
  const wanted =
    ids instanceof Set ? ids : new Set(Array.isArray(ids) ? ids : []);
  // Dedup to indexed ids, capture each id's seek offset.
  const entries = [];
  for (const id of wanted) {
    const ent = index.byId.get(id);
    if (ent == null) continue;
    entries.push({ id, offset: ent.offset });
  }
  if (entries.length === 0) return out;
  // Ascending byte offset == ledger order (append-only file).
  entries.sort((a, b) => a.offset - b.offset);

  let fd = -1;
  try {
    fd = openSync(ledgerPath, "r");
  } catch {
    return out;
  }
  try {
    for (const { id, offset } of entries) {
      let row = null;
      try {
        row = readLedgerRowAtOffset(fd, offset);
      } catch {
        row = null;
      }
      // VERIFICATION: the parsed row's id MUST equal the wanted id. A stale or
      // wrong offset yields a differing (or null) id -> miss, never a wrong row.
      if (row != null && typeof row.id === "string" && row.id === id) {
        out.set(id, row);
      }
    }
  } finally {
    if (fd !== -1) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

/**
 * buildContradictionSeed — build the reconciliation-detector seed (design.md
 * §D-2.5) for the reconstruction emitter's flag-ON path:
 *
 *   - neededIds: parents ∪ {reconstructed children of each parent} ∪ ALL
 *     policyIds. seekRows(ledgerPath, index, neededIds) then yields the minimal
 *     ledger-ordered byId subset the detector can touch.
 *   - reverseAdj: a NARROW, parent-scoped map — for each parent, the subset of
 *     index.reverseAdj.get(parent) whose child kind is "reconstructed", in
 *     ledger (Set insertion) order. This is passed EXPLICITLY to
 *     detectContradictions so it does NOT rebuild reverseAdj from the subset
 *     rows (which would drop edges) AND so the WIDE index edges (fact
 *     source_refs / policy targets children) never interleave into the
 *     sibling-walk budget — reproducing flag-OFF's detector exactly.
 *
 * @returns {{ neededIds: Set<string>, reverseAdj: Map<string, Set<string>> }}
 */
export function buildContradictionSeed(index, parents) {
  const neededIds = new Set();
  const reverseAdj = new Map();
  const parentList = Array.isArray(parents) ? parents : [];
  for (const p of parentList) {
    if (typeof p === "string" && p.length > 0) neededIds.add(p);
  }
  if (
    index != null &&
    index.reverseAdj instanceof Map &&
    index.byId instanceof Map
  ) {
    for (const parent of parentList) {
      if (typeof parent !== "string" || parent.length === 0) continue;
      const children = index.reverseAdj.get(parent);
      if (children === undefined) continue;
      let narrow = null;
      for (const childId of children) {
        const ce = index.byId.get(childId);
        if (ce && ce.kind === "reconstructed") {
          neededIds.add(childId);
          if (narrow === null) {
            narrow = new Set();
            reverseAdj.set(parent, narrow);
          }
          narrow.add(childId);
        }
      }
    }
    if (index.policyIds instanceof Set) {
      for (const pid of index.policyIds) neededIds.add(pid);
    }
  }
  return { neededIds, reverseAdj };
}

// ---------------------------------------------------------------------------
// Test-only hooks (mirror ledger-offset-index.js _resetOffsetCaches / _peekCachedIndex).
// ---------------------------------------------------------------------------
export function _resetParentIndexCache() {
  _cacheByPath.clear();
}

export function _peekParentIndex(ledgerPath) {
  return _cacheByPath.get(ledgerPath) || null;
}
