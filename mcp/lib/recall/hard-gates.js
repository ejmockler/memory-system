// hard-gates.js — Phase 3 v0 Layer 2 hard gates.
//
// Authoritative spec: kb/research-retrieval-frontiers.md
// Authoritative shape contract: kb/phase3-v0-contracts.md § 1, § 3, § 6.
// Transitive-orphan walker contract: kb/transitive-orphan-design.md (the
// design doc that pulled this forward from v2 to v0+).
//
// Layer 2 of the recall pipeline runs AFTER Layer 1 RRF candidate fusion and
// BEFORE the multi-feature-score rescore. For each candidate, in order, this
// module applies three orthogonal gates:
//
//   1. PREDICATE EXCLUSION.  Iterate over active predicates loaded from
//      policy/predicates.jsonl. Each predicate carries a dimension-tagged
//      snapshot (`query_embedding` + `embedding_dim`; legacy rows carried
//      `query_embedding_3072`). For each predicate, resolve the candidate
//      vector of the SAME dimension (embedding_4096 / embedding_3072 /
//      embedding_768) and compute full-dim cosine similarity. If
//      cosine > CAPS.PREDICATE_MATCH_COSINE_THRESHOLD (0.85), the candidate is
//      masked out (predicate_mask = 0) and `dropped_reason` records the
//      offending predicate_id. A candidate with no vector in the predicate's
//      geometry is skipped for that predicate (mask stays 1) — never a
//      cross-dimension cosine. v0 simplification: dense-cosine-only; more
//      sophisticated entity/scope rules are deferred to v2.
//
//   2. CONSENT DAMPENER.  Read entry.consent_basis. Map per CAPS:
//          first_party              -> 1.0
//          third_party_inferred     -> 0.6
//          unknown / unset / other  -> 1.0  (no dampening for unknowns; the
//                                            risk surface is conservative
//                                            elsewhere)
//      The string literal "consent_blocked" is a stronger state meaning DROP:
//      it sets predicate_mask = 0 and dropped_reason = "consent_blocked". This
//      mirrors the spec's "CONSENT_BLOCKED is a stronger state than dampener"
//      callout.
//
//   3. DERIVATION_ORPHAN (depth-aware, transitive).  If `transitive_orphan_map`
//      contains the candidate's memory_id, derivation_status is dampened per
//      the design's depth-aware formula:
//          max(FLOOR, exp(-LAMBDA * (d - 1)) * DERIVATION_STATUS_ORPHAN)
//      d=1 evaluates to 0.5 (preserves v0). d=∞ floors at 0.25. Candidates
//      absent from the map keep DERIVATION_STATUS_NORMAL (1.0). The transitive
//      walk is loaded via loadTransitiveOrphanMap below. For backward
//      compatibility (and to keep test-only callers simple), a candidate whose
//      `derived_from` directly contains an excised id ALSO trips the gate at
//      d=1 when only `derivation_excise_set` is supplied — same shape, same
//      result as v0.
//
// Candidates with predicate_mask = 0 are RETURNED, not silently dropped. The
// recall.js handler logs them in the recall ledger event's
// candidates_pre_truncation array with full provenance, so v3 off-policy
// estimators see the dropped set. Filtering happens in recall.js's Layer-2
// output consumers, which skip predicate_mask !== 1 candidates (rescore step
// g. and the salience feedback loop) — nothing in this module filters.
//
// Hermeticity: this module reads from POLICY_DIR (policy/predicates.jsonl) and
// LEDGERS_DIR (ledgers/memory.jsonl via the excise-set loader). Both paths are
// resolved via config.js; tests overriding MEMORY_ROOT / POLICY_BASE_DIR /
// LEDGERS_BASE_DIR before dynamic import are fully isolated.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { POLICY_DIR, STORAGE_DIR, memoryLedgerPath } from "../config.js";
import { CAPS } from "../validation.js";
import { appendPolicyEvent } from "../policy-events.js";
// WU-iter3-incrementalize-remaining-scans — the shared append-aware tail-merge
// (iter-2). _scanLedger's per-row streaming projection is routed through this so
// loadDerivationExciseSet + loadTransitiveOrphanMap stop re-scanning the whole
// 1.82 GB ledger on every warm query: the common daemon-append case tail-merges
// ONLY the appended bytes into the cached raw scan struct.
import {
  appendAwareLedgerProjection,
  _resetAppendAwareProjectionCache,
} from "../synthesis/append-aware-ledger-projection.js";
// Q4 (memperf) — a FRESH process previously paid the full multi-GB _scanLedgerRaw
// stream on its first recall (~3.4s). The raw scan struct is now persisted to a
// checkpoint-validated cache (S1 primitive: newline-safe pinned EOF + sampled
// prefix-identity witness) and a fresh process cold-seeds from it, folding ONLY
// the appended delta rows through the SAME _applyScanRow reducer.
import {
  captureCheckpoint,
  deserializeCheckpoint,
  emptyCheckpoint,
  readAppended,
  serializeCheckpoint,
} from "../synthesis/ledger-checkpoint.js";

// ---------------------------------------------------------------------------
// R25.5 CRIT-3 — retroactive-drop sidecar schema.
// ---------------------------------------------------------------------------
// Sidecar dir: STORAGE_DIR/salience-sidecars/
// Sidecar file glob: retroactive-drop-*.jsonl  (one file per replay-stage0 run;
// suffix is the replay_run_id so a re-run is a NEW file, not an append). Each
// row schema is:
//   {
//     dropped_at_ts:    ISO-8601 string
//     target_memory_id: string (the memory.jsonl row id to excise)
//     reason:           string (the Stage-0 rule name that fired)
//     replay_run_id:    string (same value as the filename suffix)
//     version:          number ("1" for the R25.5 wire format)
//   }
// The producer is mcp/scripts/replay-stage0.mjs; the consumer is
// hard-gates.js _scanLedger (this file). Both sides MUST agree on the path
// and schema — drift fails the regression test in
// mcp/test/recall/hard-gates-salience.test.mjs.
//
// Why a sidecar (not a policy event): retroactive_drop is operator-initiated
// and may touch tens of thousands of rows in one batch. Folding that volume
// into policy-events.jsonl would balloon the audit log and slow the recall
// hot-path that reads it. The sidecar lives next to source-replay artefacts
// and is read once per recall (cached by _scanLedger's mtime/size key).
const SALIENCE_SIDECAR_DIRNAME = "salience-sidecars";
const RETROACTIVE_DROP_PREFIX = "retroactive-drop-";
const RETROACTIVE_DROP_SUFFIX = ".jsonl";
export const RETROACTIVE_DROP_SIDECAR_VERSION = 1;

export function retroactiveDropSidecarDir() {
  return join(STORAGE_DIR, SALIENCE_SIDECAR_DIRNAME);
}

// Resolve the set of sidecar file paths matching the glob, sorted by name
// (deterministic — replay_run_id encodes a monotonic ts so newest-last sort
// is chronological).
function listRetroactiveDropSidecars(dir) {
  if (!existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (err) {
    console.error(`hard-gates: failed to readdir ${dir}: ${err.message}`);
    return [];
  }
  const out = [];
  for (const name of entries) {
    if (!name.startsWith(RETROACTIVE_DROP_PREFIX)) continue;
    if (!name.endsWith(RETROACTIVE_DROP_SUFFIX)) continue;
    out.push(join(dir, name));
  }
  out.sort();
  return out;
}

// ---------------------------------------------------------------------------
// Process-scope cache for the derivation graph + transitive-orphan map.
// ---------------------------------------------------------------------------
// Both caches key on (ledgerPath, ledger_mtime_ms, ledger_size_bytes). Tests
// that override LEDGERS_BASE_DIR per case still hit a clean miss because the
// key includes the path. Production daemons append to a single ledger; the
// cache busts on every append (mtime or size change).
//
// We keep two caches because the graph is the expensive build (full ledger
// scan) and the orphan map is a cheap join over it. A change to the
// derivation_policy of a single excise event invalidates the orphan map but
// not the graph; the mtime-based key correctly busts both at once because
// the ledger row that flipped the policy is the same write that bumps mtime.
const _graphCache = new Map(); // cacheKey -> reverseAdj Map
const _orphanMapCache = new Map(); // cacheKey -> orphan Map
// R25.5 CRIT-2: process-scope idempotency set for stale_post_revoke audit
// emits. Key shape: `${fact_id}|${revoke_event_id}`. CP-3 in salience-design.md
// names this as a best-effort drift-surface event, not a per-recall poll, so
// once-per-process is the right cadence. Process restart re-emits once for
// any cached fact-revoke pair (acceptable: the audit log is monthly-rotated
// and re-emit-on-restart is bounded by the seed_count × salienceFacts.size).
// Exposed via _resetTransitiveOrphanCaches for hermetic tests.
const _emittedStaleByKey = new Set();

function ledgerCacheKey(ledgerPath) {
  if (!existsSync(ledgerPath)) return `${ledgerPath}|absent`;
  let st;
  try {
    st = statSync(ledgerPath);
  } catch (err) {
    void err;
    return `${ledgerPath}|stat_failed`;
  }
  // Include the salience-sidecars directory in the cache key. A new
  // retroactive-drop-*.jsonl file (or a modification to an existing one)
  // MUST bust the orphan-map cache so the next recall sees the freshly
  // excised target_memory_ids. We fold every matching sidecar's
  // (basename, mtimeMs, size) into the key; sorted by name so the
  // composite is deterministic regardless of readdir order.
  let sidecarFingerprint = "no-sidecars";
  const sidecarDir = retroactiveDropSidecarDir();
  if (existsSync(sidecarDir)) {
    try {
      const names = readdirSync(sidecarDir)
        .filter(
          (n) =>
            n.startsWith(RETROACTIVE_DROP_PREFIX) &&
            n.endsWith(RETROACTIVE_DROP_SUFFIX),
        )
        .sort();
      const parts = [];
      for (const name of names) {
        try {
          const s = statSync(join(sidecarDir, name));
          parts.push(`${name}@${s.mtimeMs}@${s.size}`);
        } catch {
          parts.push(`${name}@stat_failed`);
        }
      }
      if (parts.length > 0) sidecarFingerprint = parts.join(",");
    } catch (err) {
      void err;
      sidecarFingerprint = "sidecar_readdir_failed";
    }
  }
  return `${ledgerPath}|${st.mtimeMs}|${st.size}|${sidecarFingerprint}`;
}

// WU-iter3 — namespace partitioning the append-aware projection cache for the
// shared raw ledger scan. One entry per (namespace, ledgerPath); see
// appendAwareLedgerProjection. Distinct from _graphCache/_orphanMapCache, which
// remain RESULT caches (the orphan map's BFS/rescue output, the graph's
// reverseAdj) keyed on ledgerCacheKey — those still need the sidecar fingerprint
// because the sidecar-folded excise set is part of their result.
const SCAN_LEDGER_PROJECTION_NS = "hard-gates-scan-ledger";

// Exposed for tests that want to assert cache-busting behavior. Not exported
// from the package entry; the test imports it from this file directly.
export function _resetTransitiveOrphanCaches() {
  _graphCache.clear();
  _orphanMapCache.clear();
  _emittedStaleByKey.clear();
  // WU-iter3 — also drop the shared raw-scan projection so a hermetic test that
  // re-seeds the SAME ledger path with different bytes (size+mtime can collide
  // on a coarse FS) starts cold instead of tail-merging onto a stale prefix.
  // The projection's own prefix-drift guard already catches in-place rewrites,
  // but clearing here keeps the reset semantics identical to the result caches.
  try {
    _resetAppendAwareProjectionCache();
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Cosine similarity.
// ---------------------------------------------------------------------------
// IndexEntry.embedding_3072 is a Float32Array in-memory but predicates are
// loaded fresh from JSONL each call so their query_embedding_3072 arrives as a
// plain number[]. Accept either; the inner loop is identical because both
// support indexed numeric access and .length. Returns NaN-safe 0 for any
// length mismatch (defensive — should never happen with the model pin).
function cosineSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  // Both vectors are full-3072d gemini-embedding-001 outputs which are
  // unit-norm by construction, so dot product equals cosine. No renorm here.
  return dot;
}

// ---------------------------------------------------------------------------
// loadActivePredicates: read policy/predicates.jsonl, collapse by predicate_id
// (last-write-wins), filter to active=true.
// ---------------------------------------------------------------------------
// Row schema (written by mcp/lib/tools/exclude.js since B1a2):
//   { policy_kind: "exclude", predicate_id, active: true, captured_at,
//     emitted_by, context_entities, similarity_threshold, scope, rationale,
//     recall_id, query_embedding: number[], embedding_dim: number,
//     embedding_model_version: string }
// Legacy rows carried `query_embedding_3072: number[]` instead of the
// dimension-tagged pair; they are mapped to query_embedding/embedding_dim on
// load (and keep their original query_embedding_3072 field for pre-B1a2
// consumers). Rescind tombstones are pure appends: `{ predicate_id, active: false }`
// — the whole file is collapsed by predicate_id LAST-WRITE-WINS before the
// active===true filter, so a tombstone appended after an active row retires
// the predicate without rewriting the file.
//
// Returns Array<{ predicate_id, query_embedding, embedding_dim,
// embedding_model_version, scope, active }>. Missing file is graceful:
// returns []. Malformed JSON lines and dimension-inconsistent rows (dim < 1
// or query_embedding.length !== embedding_dim) are skipped with a
// console.error so the operator can see drift without halting recall. The
// returned array is bounded by CAPS.PREDICATE_MAX_ACTIVE; entries beyond the
// cap are silently truncated (loud failure would block recall on a config
// mistake elsewhere).
//
// v0 has no caching — predicates are loaded fresh per recall. v2 may add an
// LRU keyed on file mtime; the spec calls this out as deferred.
export async function loadActivePredicates(opts = {}) {
  const policyDir = opts.policy_dir || POLICY_DIR;
  const path = join(policyDir, "predicates.jsonl");
  if (!existsSync(path)) return [];

  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    // Read failure is treated like missing file: graceful degrade. Log so the
    // operator notices.
    console.error(`hard-gates: failed to read ${path}: ${err.message}`);
    return [];
  }

  // Pass 1: normalize every parseable row and collapse by predicate_id,
  // last-write-wins across the whole file (tombstones included).
  const byId = new Map();
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (err) {
      console.error(
        `hard-gates: predicates.jsonl line ${i + 1} is not valid JSON; skipping`,
      );
      continue;
    }
    if (row == null || typeof row !== "object") continue;
    if (typeof row.predicate_id !== "string") continue;

    if (row.active === false) {
      // Tombstone: needs no vector — it only has to win the collapse.
      byId.set(row.predicate_id, {
        predicate_id: row.predicate_id,
        query_embedding: null,
        embedding_dim: 0,
        embedding_model_version: row.embedding_model_version ?? null,
        scope: row.scope ?? null,
        active: false,
      });
      continue;
    }
    if (row.active !== true) continue;

    let queryEmbedding;
    let embeddingDim;
    if (Array.isArray(row.query_embedding)) {
      // New dimension-tagged shape: the pair must be self-consistent.
      if (
        !Number.isInteger(row.embedding_dim) ||
        row.embedding_dim < 1 ||
        row.query_embedding.length !== row.embedding_dim
      ) {
        console.error(
          `hard-gates: predicates.jsonl line ${i + 1} (${row.predicate_id}) has inconsistent query_embedding/embedding_dim (len=${row.query_embedding.length}, dim=${row.embedding_dim}); skipping`,
        );
        continue;
      }
      queryEmbedding = row.query_embedding;
      embeddingDim = row.embedding_dim;
    } else if (Array.isArray(row.query_embedding_3072)) {
      // Legacy shape: dimension is implied by the array itself.
      if (row.query_embedding_3072.length < 1) {
        console.error(
          `hard-gates: predicates.jsonl line ${i + 1} (${row.predicate_id}) has an empty query_embedding_3072; skipping`,
        );
        continue;
      }
      queryEmbedding = row.query_embedding_3072;
      embeddingDim = row.query_embedding_3072.length;
    } else {
      // Active row with no usable vector: skip (legacy behavior).
      continue;
    }

    const normalized = {
      predicate_id: row.predicate_id,
      query_embedding: queryEmbedding,
      embedding_dim: embeddingDim,
      embedding_model_version: row.embedding_model_version ?? null,
      scope: row.scope ?? null,
      // Carry the durable match knobs onto the normalized predicate so the gate
      // can honor them (mirrors exclude.js hydration normalization). Before this,
      // the loader dropped similarity_threshold + context_entities and the gate
      // used the GLOBAL cap for everything and never checked entity overlap — a
      // persisted-but-ignored authz/threshold knob (the finding-2 defect).
      similarity_threshold:
        typeof row.similarity_threshold === "number" ? row.similarity_threshold : null,
      context_entities: Array.isArray(row.context_entities) ? row.context_entities : [],
      active: true,
    };
    // Back-compat: legacy rows keep their original field alongside the
    // normalized pair, so consumers that still read query_embedding_3072
    // (pre-B1a2 contract) keep working. New dim-tagged rows do not get it —
    // a 4096 vector under a *_3072 name would be a lie.
    if (Array.isArray(row.query_embedding_3072)) {
      normalized.query_embedding_3072 = row.query_embedding_3072;
    }
    byId.set(row.predicate_id, normalized);
  }

  // Pass 2: filter active===true, then truncate at the cap.
  const out = [];
  for (const pred of byId.values()) {
    if (pred.active !== true) continue;
    out.push(pred);
    if (out.length >= CAPS.PREDICATE_MAX_ACTIVE) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// _scanLedger: single-pass parse of memory.jsonl into the structures every
// transitive-orphan loader needs. Returns { reverseAdj, exciseRows, rescinded
// PolicyIds }. Used internally by loadDerivationExciseSet, loadDerivationGraph,
// and loadTransitiveOrphanMap. Caches the result keyed on the ledger's
// (mtime, size) tuple so a recall flurry only pays the parse cost once.
// ---------------------------------------------------------------------------
// WU-iter3 — the empty raw-scan struct. Every field is APPEND-MERGEABLE under
// ledger append order: reverseAdj/memoryIdsBySource/corroborationByTarget are
// set-add or array-push; rescindedPolicyIds/revokedSources are set-add;
// salienceFacts/revokeMetaBySource are last-write-wins Map.set; exciseRows is an
// append-only push. A tail-merge of the appended rows in ledger order therefore
// yields a struct byte-identical to a full rebuild over the whole file.
//
// NOTE: connector_revoke `targets[]` resolution and retroactive-drop sidecar
// folding are NOT part of this raw struct — they are post-scan steps that depend
// on the COMPLETE memoryIdsBySource map / external sidecar files and are re-run
// per call by _resolveScan over a shallow clone, so the cached raw struct is
// never mutated by them (keeping the next tail-merge correct).
function _makeEmptyScan() {
  return {
    reverseAdj: new Map(),         // ancestor_id -> Set<descendant_id>
    exciseRows: [],                // {policy_event_id, targets[], silent, policy, active}
    rescindedPolicyIds: new Set(), // policy_event_ids that have been rescinded
    corroborationByTarget: new Map(), // target_memory_id -> [source_ref...]
    // Round-21 (d) hot-fix: connector_revoke kill-switch wiring. The round-20
    // C4 design specified that a policy event with policy_kind="connector_revoke"
    // + target_source=<source> acts as a new excise seed by joining
    // target_source against every memory event's source_refs[].source. The
    // scanner now collects both sides:
    //   revokedSources: Set<source> from connector_revoke policy events
    //   memoryIdsBySource: Map<source, Set<memory_id>> from source_refs[].source
    // loadDerivationExciseSet folds revokedSources → memory_ids via the map
    // and seeds those into the excise set, so the transitive-orphan BFS
    // propagates as expected. Authoritative: kb/connectors-survey.md § imessage
    // kill-switch + kb/transitive-orphan-design.md § seed set.
    revokedSources: new Set(),
    memoryIdsBySource: new Map(),
    // R25.5 CRIT-2 — facts that carry features.salience. Used by
    // loadTransitiveOrphanMap to emit policy.salience.stale_post_revoke
    // exactly once per BFS-discovered transitive orphan that derives
    // from a revoked source. Map<memory_id, {novelty, source_of_revoke?}>.
    // novelty is the s_novelty component recorded at promote-time (may
    // be null if the salience block is malformed). The "stale" semantics
    // are CP-3 from salience-design.md: facts are NOT recomputed;
    // the audit event surfaces the drift.
    salienceFacts: new Map(),
    // R25.5 CRIT-2 — map target_source -> revoke event metadata so the
    // BFS emitter can record which revoke caused the stale-drift surface.
    // Multiple revokes on the same source (e.g. revoke -> rescind -> revoke)
    // collapse to the last-seen active revoke; CP-3 names it as best-effort
    // audit, not idempotent.
    revokeMetaBySource: new Map(), // source -> {revoke_event_id, ts}
    // Q4 — monotone mutation counter, bumped once per row folded into this
    // struct (full scan, delta fold, warm tail-merge alike). Used as a
    // persist-time guard: the scheduled cache write is SKIPPED if any row
    // folded after the checkpoint was pinned, because exciseRows /
    // corroborationByTarget are push-arrays (NOT idempotent under re-fold)
    // and an over-covered persisted state would duplicate their entries on
    // the next cold load. Internal; never serialized, never exposed on the
    // _scanLedger return.
    _rowsApplied: 0,
  };
}

// WU-iter3 — fold ONE parsed ledger row into the raw-scan struct. Extracted
// verbatim from the previous streamLedgerLines callback body so the tail-merge
// path and the full-rebuild path apply IDENTICAL per-row semantics. Pure ADD /
// last-write-wins; never reads back the whole struct, so order-independence
// across the prefix/tail split is preserved (every appended row is applied AFTER
// the cached prefix rows in ledger order, exactly as a full scan would).
function _applyScanRow(out, row) {
  {
    // Q4 persist guard — count EVERY delivered row (even ones filtered just
    // below) so the scheduled persist can detect any interleaved fold.
    out._rowsApplied = (out._rowsApplied ?? 0) + 1;
    if (row == null || typeof row !== "object") return;

    // Derivation edge: every event with a derived_from[] contributes its
    // descendants to the reverse-adjacency map. fact-kind rows are the
    // primary contributors; we accept any kind that exposes the edge.
    if (Array.isArray(row.derived_from) && typeof row.id === "string") {
      for (const ancestor of row.derived_from) {
        if (typeof ancestor !== "string" || ancestor === "") continue;
        let set = out.reverseAdj.get(ancestor);
        if (set == null) {
          set = new Set();
          out.reverseAdj.set(ancestor, set);
        }
        set.add(row.id);
      }
    }

    // Round-21 (d) hot-fix: build the source -> memory_ids map for the
    // connector_revoke kill-switch resolution at loadDerivationExciseSet
    // time. Any non-policy event with source_refs[].source contributes.
    if (row.kind !== "policy" && typeof row.id === "string" && Array.isArray(row.source_refs)) {
      for (const sref of row.source_refs) {
        if (!sref || typeof sref !== "object") continue;
        const src = typeof sref.source === "string" ? sref.source : null;
        if (src == null || src === "") continue;
        let set = out.memoryIdsBySource.get(src);
        if (set == null) {
          set = new Set();
          out.memoryIdsBySource.set(src, set);
        }
        set.add(row.id);
      }
    }

    // R25.5 CRIT-2: capture facts that carry features.salience so the
    // transitive-orphan BFS can emit stale_post_revoke at the discovery
    // moment. The salience block is attached at promote-time by
    // mcp/lib/ingest/salience.js per kb/salience-design.md § "Storage +
    // recall integration"; rows without features.salience predate R25 or
    // came from a non-salience path (e.g. explicit memory_put) and need
    // no stale-drift audit event.
    if (
      row.kind !== "policy" &&
      typeof row.id === "string" &&
      row.features != null &&
      typeof row.features === "object" &&
      row.features.salience != null &&
      typeof row.features.salience === "object"
    ) {
      const sal = row.features.salience;
      let novelty = null;
      if (
        sal.components != null &&
        typeof sal.components === "object" &&
        typeof sal.components.novelty === "number"
      ) {
        novelty = sal.components.novelty;
      }
      out.salienceFacts.set(row.id, { novelty });
    }

    if (row.kind !== "policy") return;

    // policy_kind: "rescind" — deactivates a target policy event.
    if (row.policy_kind === "rescind") {
      const targets = Array.isArray(row.targets) ? row.targets : [];
      for (const t of targets) {
        if (typeof t === "string" && t.length > 0) {
          out.rescindedPolicyIds.add(t);
        }
      }
      return;
    }

    // policy_kind: "corroboration" — projects extra source_refs onto a fact.
    // Schema per architecture.md § policy.corroboration:
    //   targets: [target_memory_id]
    //   payload: { source_ref: { ..., target_memory_id? } }
    if (row.policy_kind === "corroboration") {
      // Skip rescinded corroborations (matched on their own id below).
      const targets = Array.isArray(row.targets) ? row.targets : [];
      const payload = (row.payload && typeof row.payload === "object") ? row.payload : {};
      const sourceRef = payload.source_ref ?? null;
      if (sourceRef != null) {
        for (const t of targets) {
          if (typeof t !== "string" || t === "") continue;
          let arr = out.corroborationByTarget.get(t);
          if (arr == null) {
            arr = [];
            out.corroborationByTarget.set(t, arr);
          }
          arr.push({
            corroboration_event_id: typeof row.id === "string" ? row.id : null,
            source_ref: sourceRef,
          });
        }
      }
      return;
    }

    // Round-21 (d) hot-fix: connector_revoke produces excise-equivalent seeds
    // by joining target_source against memoryIdsBySource. We accumulate the
    // target_source value here; loadDerivationExciseSet resolves it to
    // memory_ids and synthesizes an exciseRows entry. Rescindable like any
    // policy event; honors active=false inline-deactivation.
    if (row.policy_kind === "connector_revoke") {
      const target = typeof row.target_source === "string" ? row.target_source : null;
      if (target != null && target !== "" && row.active !== false) {
        out.revokedSources.add(target);
        // R25.5 CRIT-2: record (source -> last-active-revoke) so the BFS
        // emitter knows which revoke_event_id to attribute the
        // stale_post_revoke audit event to. Overwrite is intentional —
        // the freshest active revoke is the one the operator cares about;
        // older revokes that were rescinded then re-issued would otherwise
        // attribute to a stale id.
        out.revokeMetaBySource.set(target, {
          revoke_event_id: typeof row.id === "string" ? row.id : null,
          ts: typeof row.ts === "string" ? row.ts : null,
        });
        // Synthesize an exciseRows entry that the existing seed-set machinery
        // can consume directly. targets[] is computed at exciseSet-build time
        // (since memoryIdsBySource may not be complete when this row is
        // scanned — sources can appear after the revoke in append order); we
        // store a marker { connector_revoke: true, target_source } and resolve
        // at loadDerivationExciseSet time.
        out.exciseRows.push({
          policy_event_id: typeof row.id === "string" ? row.id : null,
          connector_revoke: true,
          target_source: target,
          targets: [], // resolved post-scan
          silent: row.silent === true,
          derivation_policy:
            typeof row.derivation_policy === "string"
              ? row.derivation_policy
              : "drop",
          active_inline: row.active !== false,
        });
      }
      return;
    }

    // policy_kind: "excise" — the seed set for the transitive walk. We keep
    // the row so the derivation_policy and silent flag are visible to the
    // seed-filter step.
    if (row.policy_kind !== "excise") return;
    const targets = Array.isArray(row.targets) ? row.targets : [];
    out.exciseRows.push({
      policy_event_id: typeof row.id === "string" ? row.id : null,
      targets: targets.filter((t) => typeof t === "string" && t.length > 0),
      silent: row.silent === true,
      // derivation_policy: spec defaults unset to "drop" per mcp-surface.md
      // § memory_excise default scope semantics.
      derivation_policy:
        typeof row.derivation_policy === "string"
          ? row.derivation_policy
          : "drop",
      // Inline-deactivation form (row.active === false) is also honored, in
      // addition to the separate policy_kind: "rescind" pattern.
      active_inline: row.active !== false,
    });
  }
}

// ---------------------------------------------------------------------------
// Q4 — persisted raw-scan cache (checkpoint-validated cold seed).
// ---------------------------------------------------------------------------
// Cache file under STORAGE_DIR. Payload = { schema_version, ledger_path,
// serialized S1 checkpoint, built_at, scan: <serialized raw struct> }. The
// persisted state is EXACTLY the append-mergeable raw struct — the per-call
// post-scan steps (connector_revoke targets[] resolution, retroactive-drop
// sidecar folding) stay OUTSIDE it, re-derived by _scanLedger every call.
//
// PARTICIPATION GATE: the disk cache engages ONLY when ledgerPath is the
// config-resolved production ledger (memoryLedgerPath(), hermetic under env
// overrides). Tests that pass arbitrary fixture paths (e.g.
// hard-gates-incremental-scan.test.mjs, which does NOT override STORAGE_DIR)
// keep the pure in-memory behavior and never touch production storage/.
// v2 (proto-key trap fix): every string-keyed Map now serializes as a
// proto-safe entry-array [[k, value], ...] instead of a plain {} object, so a
// ledger-derived key === "__proto__" (or "constructor"/"prototype") round-trips
// losslessly instead of invoking the inherited object setter (which JSON-omits
// it and drops it on Object.keys() deserialize — a REVOKED source would then
// resolve no memory ids and regain recall eligibility after a cache load). The
// bump ensures any pre-existing v1-format cache on disk is IGNORED and rebuilt,
// never fed to the v2 deserializer (which expects entry-arrays).
const HARD_GATES_SCAN_CACHE_SCHEMA_VERSION = "v2";

function _scanCachePath() {
  return join(STORAGE_DIR, "hard-gates-scan.cache.json");
}

// Reversal-bearing state (rescinds, corroboration rescue) — every Map/Set is
// serialized faithfully so the deserialized struct folds delta rows through
// the SAME _applyScanRow reducer with identical semantics by construction.
//
// PROTO-KEY TRAP (v2): every string-keyed Map serializes as an ENTRY-ARRAY
// [[k, value], ...], never a plain {} object. reverseAdj/memoryIdsBySource keys
// are ledger-derived (derived_from ancestor ids, source_refs[].source) and can
// be the literal "__proto__" / "constructor" / "prototype"; assigning those to
// a plain object invokes the inherited setter (or shadows a builtin), and
// Object.keys() then drops "__proto__" entirely — a REVOKED connector source
// keyed "__proto__" would silently resolve no memory ids on the next cold load
// and regain recall eligibility. Entry-arrays are index-addressed, so hostile
// keys round-trip losslessly. Set values become [k, [...set]]. revokedSources /
// rescindedPolicyIds / exciseRows are already plain arrays (no dynamic keys)
// and stay as-is.
function _serializeScanStruct(s) {
  const adj = [];
  for (const [k, v] of s.reverseAdj) adj.push([k, Array.from(v)]);
  const bySource = [];
  for (const [k, v] of s.memoryIdsBySource) bySource.push([k, Array.from(v)]);
  const corr = [];
  for (const [k, v] of s.corroborationByTarget) corr.push([k, v]);
  const salience = [];
  for (const [k, v] of s.salienceFacts) salience.push([k, v]);
  const revokeMeta = [];
  for (const [k, v] of s.revokeMetaBySource) revokeMeta.push([k, v]);
  return {
    reverseAdj: adj,
    exciseRows: s.exciseRows,
    rescindedPolicyIds: Array.from(s.rescindedPolicyIds),
    corroborationByTarget: corr,
    revokedSources: Array.from(s.revokedSources),
    memoryIdsBySource: bySource,
    salienceFacts: salience,
    revokeMetaBySource: revokeMeta,
  };
}

// Strict-enough deserializer: any structural surprise returns null and the
// caller fails closed into a full rebuild.
//
// PROTO-KEY TRAP (v2): the string-keyed maps arrive as entry-arrays
// [[k, value], ...]; we map.set(k, ...) so hostile keys ("__proto__",
// "constructor", "prototype") land as ordinary Map entries (Map has no
// __proto__ setter trap). Each entry MUST be a 2-tuple [string, payload]; any
// other shape (not an array, wrong arity, non-string key, non-array Set
// payload) is a structural surprise → return null so the caller rebuilds from
// scratch. The schema_version bump to v2 (validated in _coldSeedScanStruct)
// guarantees a legacy v1 plain-object cache is never routed here.
function _deserializeMapEntries(entries, setter) {
  if (!Array.isArray(entries)) return false;
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) return false;
    const [k, payload] = entry;
    if (typeof k !== "string") return false;
    if (setter(k, payload) === false) return false;
  }
  return true;
}

function _deserializeScanStruct(scan) {
  if (scan == null || typeof scan !== "object") return null;
  try {
    const out = _makeEmptyScan();
    if (
      !_deserializeMapEntries(scan.reverseAdj, (k, arr) => {
        if (!Array.isArray(arr)) return false;
        out.reverseAdj.set(k, new Set(arr.filter((x) => typeof x === "string")));
      })
    ) {
      return null;
    }
    if (!Array.isArray(scan.exciseRows)) return null;
    for (const row of scan.exciseRows) {
      if (row == null || typeof row !== "object") return null;
      out.exciseRows.push(row);
    }
    if (!Array.isArray(scan.rescindedPolicyIds)) return null;
    for (const id of scan.rescindedPolicyIds) {
      if (typeof id === "string") out.rescindedPolicyIds.add(id);
    }
    if (
      !_deserializeMapEntries(scan.corroborationByTarget, (k, arr) => {
        if (!Array.isArray(arr)) return false;
        out.corroborationByTarget.set(k, arr);
      })
    ) {
      return null;
    }
    if (!Array.isArray(scan.revokedSources)) return null;
    for (const src of scan.revokedSources) {
      if (typeof src === "string") out.revokedSources.add(src);
    }
    if (
      !_deserializeMapEntries(scan.memoryIdsBySource, (k, arr) => {
        if (!Array.isArray(arr)) return false;
        out.memoryIdsBySource.set(k, new Set(arr.filter((x) => typeof x === "string")));
      })
    ) {
      return null;
    }
    if (
      !_deserializeMapEntries(scan.salienceFacts, (k, v) => {
        if (v == null || typeof v !== "object") return false;
        out.salienceFacts.set(k, v);
      })
    ) {
      return null;
    }
    if (
      !_deserializeMapEntries(scan.revokeMetaBySource, (k, v) => {
        if (v == null || typeof v !== "object") return false;
        out.revokeMetaBySource.set(k, v);
      })
    ) {
      return null;
    }
    return out;
  } catch {
    return null;
  }
}

// Fold exactly the terminated rows in [fromCp.eof, toCp.eof) through the SAME
// _applyScanRow reducer the full scan and the warm tail-merge use.
function _foldScanRows(ledgerPath, fromCp, toCp, struct) {
  let rows = 0;
  const res = readAppended(ledgerPath, fromCp, toCp, (text) => {
    rows += 1;
    try {
      _applyScanRow(struct, JSON.parse(text));
    } catch {
      // A single malformed row never aborts the fold.
    }
  });
  return { rows, error: res.error };
}

// Size-gated incremental persist (see derivation-graph.js — same policy): a
// fresh process re-folds at most this many un-persisted delta bytes.
const SCAN_PERSIST_DELTA_BYTES_CAP = 16 * 1024 * 1024; // 16 MiB, frozen

// Last cold-seed outcome, observable by the equivalence tests (the delta-fold
// path must be provably taken, not inferred).
let _lastScanColdStats = null;

/** Test-only: { mode, rows_folded } of the most recent cold raw-scan seed. */
export function __peekScanColdStatsForTests() {
  return _lastScanColdStats;
}

// In-flight best-effort persists (fire-and-forget off the recall path).
const _pendingScanPersists = new Set();

/** Await every in-flight scheduled scan-cache persist (tests + scripts). */
export async function _awaitPendingScanCachePersists() {
  while (_pendingScanPersists.size > 0) {
    await Promise.all([..._pendingScanPersists]);
  }
}

/**
 * Schedule a best-effort atomic persist of the raw scan struct. NEVER awaited
 * on the recall path; errors swallowed. The struct is serialized when the
 * task runs; `rowsAppliedAtPin` guards against interleaved folds — exciseRows
 * and corroborationByTarget are push-arrays, so a struct that gained rows
 * after the checkpoint pin would OVER-cover the persisted state and duplicate
 * pushes on the next cold load. If any row folded in between, the persist is
 * skipped (the cache simply stays at its previous, still-valid state).
 */
function _scheduleScanPersist(struct, checkpoint, ledgerPath, rowsAppliedAtPin) {
  const cachePath = _scanCachePath();
  const p = new Promise((resolve) => setImmediate(resolve))
    .then(async () => {
      if (struct._rowsApplied !== rowsAppliedAtPin) return; // interleaved fold
      const payload = {
        schema_version: HARD_GATES_SCAN_CACHE_SCHEMA_VERSION,
        ledger_path: ledgerPath,
        checkpoint: serializeCheckpoint(checkpoint),
        built_at: new Date().toISOString(),
        scan: _serializeScanStruct(struct),
      };
      const tmpPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
      try {
        await mkdir(dirname(cachePath), { recursive: true });
        await writeFile(tmpPath, JSON.stringify(payload), { mode: 0o600 });
        await rename(tmpPath, cachePath);
      } catch {
        try {
          await rm(tmpPath, { force: true });
        } catch {
          // best-effort tmp hygiene
        }
      }
    })
    .catch(() => {
      // Best-effort: a persist failure must never surface on the recall path.
    })
    .finally(() => {
      _pendingScanPersists.delete(p);
    });
  _pendingScanPersists.add(p);
}

/**
 * Q4 cold seed for the raw scan struct: checkpoint-validated disk cache +
 * delta fold, else pin-first full rebuild. Mirrors content-index.js v2:
 * captureCheckpoint({prev}) runs the ONE O(witness) prefix verification per
 * load; soundness is gated on the S1c flags (extendedPrev — verbatim witness
 * extension — or prefixVerified — witness-cap re-baseline with the prefix
 * verified inside the capture call). Any other outcome (shrink, rewrite,
 * atomic replacement) is a discontinuity: full rebuild, never a hybrid.
 * Exact-eof match serves the cached struct with ZERO disk writes.
 */
function _coldSeedScanStruct(ledgerPath) {
  // FIX CYCLE 2: return the appendAwareLedgerProjection wrapped shape
  // { struct, resumeOffset } — resumeOffset is the pinned checkpoint eof (the
  // seed's EXACT byte coverage), so the projection layer resumes the next
  // grow-merge there instead of at raw st.size. A row torn at seed time
  // (e.g. a rescind) is then re-read once its "\n" lands — never permanently
  // lost. The degraded path (no checkpoint) reports resumeOffset null; the
  // helper falls back to the historical raw-size resume.
  const finish = (struct, mode, rowsFolded, resumeOffset = null) => {
    _lastScanColdStats = { mode, rows_folded: rowsFolded };
    return { struct, resumeOffset };
  };
  const cachePath = _scanCachePath();
  if (existsSync(cachePath)) {
    try {
      const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
      if (
        parsed != null &&
        parsed.schema_version === HARD_GATES_SCAN_CACHE_SCHEMA_VERSION &&
        parsed.ledger_path === ledgerPath
      ) {
        const cachedCp = deserializeCheckpoint(parsed.checkpoint);
        if (cachedCp !== null) {
          // PIN FIRST, then read only bytes at/below the pinned eof.
          const newCp = captureCheckpoint(ledgerPath, { prev: cachedCp });
          if (
            newCp !== null &&
            (newCp.extendedPrev === true || newCp.prefixVerified === true)
          ) {
            const struct = _deserializeScanStruct(parsed.scan);
            if (struct !== null) {
              if (newCp.eof === cachedCp.eof) {
                return finish(struct, "cache-hit-exact", 0, newCp.eof);
              }
              const { rows, error } = _foldScanRows(ledgerPath, cachedCp, newCp, struct);
              if (error === null) {
                const rebaselined = newCp.extendedPrev !== true;
                const deltaBytes = newCp.eof - cachedCp.eof;
                if (rebaselined || deltaBytes > SCAN_PERSIST_DELTA_BYTES_CAP) {
                  _scheduleScanPersist(struct, newCp, ledgerPath, struct._rowsApplied);
                }
                return finish(struct, "incremental", rows, newCp.eof);
              }
              // Fold error between pin and read: DISCARD the partial struct
              // (it describes a file that no longer exists) — full rebuild.
            }
          }
        }
      }
    } catch {
      // Corrupt cache → full rebuild below.
    }
  }

  // FULL REBUILD — pin-first so the persisted checkpoint covers exactly the
  // folded byte range; the tolerant legacy stream fallback certifies nothing
  // and persists nothing.
  const cp = captureCheckpoint(ledgerPath);
  if (cp !== null) {
    const struct = _makeEmptyScan();
    const { rows, error } = _foldScanRows(ledgerPath, emptyCheckpoint(), cp, struct);
    if (error === null) {
      _scheduleScanPersist(struct, cp, ledgerPath, struct._rowsApplied);
      return finish(struct, "full-rebuild", rows, cp.eof);
    }
  }
  // Missing / unreadable / raced ledger: empty struct, nothing certified,
  // nothing persisted (parity with the pre-Q4 missing-ledger behavior).
  return finish(_makeEmptyScan(), "full-rebuild-degraded", 0);
}

// WU-iter3 — the cached RAW projection over the append-only ledger. Routed
// through the iter-2 appendAwareLedgerProjection helper so the common warm-path
// daemon-append case tail-merges ONLY the appended bytes into the cached struct
// instead of re-streaming the whole 1.82 GB file (the remaining ~4.7s/query
// scan the iter-3 audit targeted). All three hard-gates loaders share this one
// namespace, so a cold first query pays the full stream ONCE (not twice), and
// every subsequent query pays only the tail.
//
// Q4 — the COLD branch (first call in a fresh process) additionally seeds from
// the checkpoint-validated disk cache via _coldSeedScanStruct, so a fresh
// process folds ONLY the appended delta instead of re-streaming the multi-GB
// ledger. The disk cache participates ONLY for the config-resolved production
// ledger (see the participation gate above); explicit fixture paths keep the
// pure in-memory behavior.
//
// The struct holds ONLY append-mergeable fields (see _makeEmptyScan). The
// non-mergeable post-scan steps (connector_revoke target resolution + sidecar
// folding) are applied per-call in _scanLedger over a shallow clone, never into
// this cached struct. Returns the empty struct when the ledger is missing (the
// helper returns null in that case, mirroring the previous existsSync guard).
function _scanLedgerRaw(ledgerPath) {
  const useDiskCache = ledgerPath === memoryLedgerPath();
  const struct = appendAwareLedgerProjection({
    ledgerPath,
    namespace: SCAN_LEDGER_PROJECTION_NS,
    makeEmpty: _makeEmptyScan,
    applyParsedRow: _applyScanRow,
    ...(useDiskCache
      ? {
          fullRebuild: (lp) => {
            // Missing-ledger guard: the helper also routes st==null here when
            // a fullRebuild is supplied; keep the empty-struct contract.
            if (!existsSync(lp)) return _makeEmptyScan();
            return _coldSeedScanStruct(lp);
          },
        }
      : {}),
  });
  return struct == null ? _makeEmptyScan() : struct;
}

// ---------------------------------------------------------------------------
// _scanLedger: single-pass parse of memory.jsonl into the structures every
// transitive-orphan loader needs. Returns { reverseAdj, exciseRows, rescinded
// PolicyIds, ... }. Used internally by loadDerivationExciseSet,
// loadDerivationGraph, and loadTransitiveOrphanMap.
// ---------------------------------------------------------------------------
// WU-iter3 — the heavy per-row streaming projection is now CACHED + tail-merged
// via _scanLedgerRaw. This wrapper layers the two NON-append-mergeable post-scan
// steps on top, WITHOUT mutating the cached raw struct:
//
//   1. connector_revoke resolution — re-derived every call because the appended
//      tail may have added memory rows for an already-seen revoked source, so a
//      previously-resolved targets[] could be STALE. We resolve onto a CLONE of
//      each connector_revoke row (never the cached marker, which must stay
//      targets:[] so the next tail-merge starts from the unresolved seed).
//   2. retroactive-drop sidecar folding — sidecar files change INDEPENDENTLY of
//      the ledger (they are not append rows), so a cached-then-tail-merged struct
//      would never see a new sidecar. We re-read + fold them every call.
//
// The returned struct SHARES the append-mergeable maps (reverseAdj, etc.) with
// the cache by reference (they are read-only downstream) but exposes a FRESH
// exciseRows array so per-call resolution/folding never corrupts the cache.
// Exported for the WU-iter3 incremental-scan regression test: it asserts the
// tail-merged struct is structurally identical to a fresh full rebuild. Not part
// of the package entry surface.
export function _scanLedger(ledgerPath) {
  const raw = _scanLedgerRaw(ledgerPath);

  // Build a fresh exciseRows for this call. Direct-excise + sidecar rows are
  // immutable post-build, so direct-excise rows can be shared by reference;
  // connector_revoke rows are CLONED so resolving their targets[] does not write
  // into the cached marker.
  const exciseRows = [];
  for (const exciseRow of raw.exciseRows) {
    if (exciseRow.connector_revoke === true) {
      // Round-21 (d) hot-fix: resolve connector_revoke synthesized rows against
      // the (possibly tail-merged) memoryIdsBySource map. Map target_source to
      // memory_ids and populate the targets[] field on a CLONE. Any row whose
      // target_source had zero matching memory events is left with targets=[] —
      // harmless; the seed-set machinery folds in nothing for that revoke.
      const memIds = raw.memoryIdsBySource.get(exciseRow.target_source);
      const resolvedTargets =
        memIds != null && memIds.size > 0 ? Array.from(memIds) : [];
      exciseRows.push({ ...exciseRow, targets: resolvedTargets });
    } else {
      exciseRows.push(exciseRow);
    }
  }

  const out = {
    reverseAdj: raw.reverseAdj,
    exciseRows,
    rescindedPolicyIds: raw.rescindedPolicyIds,
    corroborationByTarget: raw.corroborationByTarget,
    revokedSources: raw.revokedSources,
    memoryIdsBySource: raw.memoryIdsBySource,
    salienceFacts: raw.salienceFacts,
    revokeMetaBySource: raw.revokeMetaBySource,
  };

  // R25.5 CRIT-3: fold replay-stage0 retroactive-drop sidecars into the
  // excise seed set. Each sidecar file under STORAGE_DIR/salience-sidecars/
  // matching retroactive-drop-*.jsonl contributes its target_memory_id rows
  // to a synthetic excise row. Schema is documented at the top of this file
  // (RETROACTIVE_DROP_SIDECAR_VERSION). Malformed rows are skipped with a
  // console.error so the operator can see drift without halting recall.
  //
  // The synthesized excise row is marked retroactive_drop: true so the
  // observability path (and the new regression test) can distinguish it
  // from connector_revoke + direct-excise rows. silent stays false (the
  // recall layer's candidates_pre_truncation channel should still surface
  // the dropped set with a "retroactive_drop:<reason>" dropped_reason so
  // v3 off-policy estimators see it).
  const sidecarDir = retroactiveDropSidecarDir();
  const sidecarFiles = listRetroactiveDropSidecars(sidecarDir);
  for (const sidecarPath of sidecarFiles) {
    let raw;
    try {
      raw = readFileSync(sidecarPath, "utf8");
    } catch (err) {
      console.error(
        `hard-gates: failed to read ${sidecarPath}: ${err.message}`,
      );
      continue;
    }
    const targets = [];
    let firstReason = null;
    let firstRunId = null;
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === "") continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        console.error(
          `hard-gates: ${sidecarPath} line ${i + 1} is not valid JSON; skipping`,
        );
        continue;
      }
      if (row == null || typeof row !== "object") continue;
      if (typeof row.target_memory_id !== "string" || row.target_memory_id === "") {
        continue;
      }
      // Version gate: only known schema versions contribute. A future
      // breaking-change bump means the consumer is upgraded before the
      // producer; the operator sees a no-op until then.
      if (row.version !== RETROACTIVE_DROP_SIDECAR_VERSION) continue;
      targets.push(row.target_memory_id);
      if (firstReason == null && typeof row.reason === "string") {
        firstReason = row.reason;
      }
      if (firstRunId == null && typeof row.replay_run_id === "string") {
        firstRunId = row.replay_run_id;
      }
    }
    if (targets.length === 0) continue;
    out.exciseRows.push({
      // Use the sidecar's filename as the policy_event_id so rescinds
      // can in principle target the whole file (no rescind mechanism in
      // R25.5 — the file is the unit of revert). policy_event_id is also
      // consulted by the rescindedPolicyIds filter; we use the basename
      // so it is human-grep-able from a rescind policy event.
      policy_event_id: sidecarPath,
      retroactive_drop: true,
      replay_run_id: firstRunId,
      reason: firstReason,
      targets,
      silent: false,
      derivation_policy: "drop",
      active_inline: true,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// loadDerivationExciseSet (v0+ backward-compat): scan ledgers/memory.jsonl for
// policy/excise events, return a Set<memory_id> of excised targets.
// ---------------------------------------------------------------------------
// Per architecture.md § Memory ledger, policy events carry `targets: [id, ...]`
// naming the facts the policy acts on. An excise event excises each id in
// `targets[]`. This loader returns ONLY direct-excise targets (the shallow,
// v0 set). For the transitive forward closure, callers use
// loadTransitiveOrphanMap below.
//
// Filtering rules (per kb/transitive-orphan-design.md § 1):
//   - silent: true            -> excluded (opaque to recall by construction)
//   - derivation_policy:
//        "drop" | "re_derive_without"  -> INCLUDED
//        "retain"                       -> excluded (user opted into keeping
//                                                    descendants live)
//        unset                          -> treated as "drop" (spec default)
//   - rescinded (inline active: false OR a separate policy_kind: "rescind"
//     row targeting this policy_event_id) -> excluded
//
// The set returned mirrors what applyHardGates already consumed in v0: the
// direct-ancestor check still functions exactly as before. v0 callers that
// passed this set to applyHardGates with no transitive_orphan_map receive
// the v0 behavior unchanged.
//
// Missing ledger file is graceful: returns empty Set. Malformed JSONL lines
// are skipped with a console.error.
export async function loadDerivationExciseSet(opts = {}) {
  const ledgerPath = opts.ledger_path || memoryLedgerPath();
  const excised = new Set();
  const scan = _scanLedger(ledgerPath);
  for (const row of scan.exciseRows) {
    if (row.silent) continue;
    if (!row.active_inline) continue;
    if (row.policy_event_id && scan.rescindedPolicyIds.has(row.policy_event_id)) {
      continue;
    }
    if (row.derivation_policy === "retain") continue;
    // "drop" and "re_derive_without" both seed the transitive walk; the
    // distinction matters at excise-emit time (rederive triggers a separate
    // job), not at recall-time gate evaluation.
    for (const t of row.targets) {
      excised.add(t);
    }
  }
  return excised;
}

// ---------------------------------------------------------------------------
// loadDerivationGraph: builds the reverse-adjacency Map<ancestor_id,
// Set<descendant_id>> by a single ledger scan. Cached on (path, mtime, size).
// ---------------------------------------------------------------------------
// Used by loadTransitiveOrphanMap for the forward BFS. Exposed so tests can
// assert the graph shape directly.
//
// Missing ledger file is graceful: returns an empty Map.
export async function loadDerivationGraph(opts = {}) {
  const ledgerPath = opts.ledger_path || memoryLedgerPath();
  const key = ledgerCacheKey(ledgerPath);
  const cached = _graphCache.get(key);
  if (cached != null) return cached;
  const scan = _scanLedger(ledgerPath);
  _graphCache.set(key, scan.reverseAdj);
  return scan.reverseAdj;
}

// ---------------------------------------------------------------------------
// loadTransitiveOrphanMap: combines the direct-excise seed set with the
// reverse adjacency, runs forward BFS, applies corroboration rescue, and
// returns Map<memory_id, { distance_to_nearest_excised, transitive_orphan,
// rescued_by_corroboration }>.
// ---------------------------------------------------------------------------
// Returns an empty Map when there are no eligible excise rows OR when the
// ledger is missing. The returned object includes a synthetic key per visited
// descendant; non-orphan candidates are NOT present in the Map (lookup absent
// = NORMAL).
//
// Caps (per CAPS, design § 2):
//   - depth bounded by CAPS.MAX_DERIVATION_DEPTH
//   - total visited bounded by CAPS.TRANSITIVE_ORPHAN_DESCENDANTS_CAP
// On cap-overflow we emit a single console.warn so the operator (and the
// recall-log substrate, via a downstream emitter) can record the partial
// coverage; v1+ may wire this to a proper policy.recall.transitive_orphan_
// cap_exceeded event.
//
// Corroboration rescue (design § 1, § 2): a descendant whose effective
// source_refs[] (post corroboration projection) contains at least one entry
// pointing to a non-excised, non-orphan target is RESCUED (removed from the
// orphan map). The rescued_by_corroboration flag is set; this is reported by
// the loader but not currently surfaced through applyHardGates (the v3
// recall-log feature_breakdown is the consumer).
export async function loadTransitiveOrphanMap(opts = {}) {
  const ledgerPath = opts.ledger_path || memoryLedgerPath();
  const key = ledgerCacheKey(ledgerPath);
  const cached = _orphanMapCache.get(key);
  if (cached != null) return cached;

  const scan = _scanLedger(ledgerPath);

  // Build seed set with the same filtering rules as loadDerivationExciseSet.
  // R25.5 CRIT-2: also track which seeds came from a connector_revoke row so
  // that descendants reached via BFS with features.salience can be emitted
  // as stale_post_revoke (one emit per (fact_id, revoke_event_id) pair so
  // re-running recall does not flood the audit log on every query). The
  // attribution map is built here and consulted inside the BFS loop.
  const seeds = new Set();
  const seedRevokeAttribution = new Map(); // seed_memory_id -> {revoke_event_id, target_source}
  for (const row of scan.exciseRows) {
    if (row.silent) continue;
    if (!row.active_inline) continue;
    if (row.policy_event_id && scan.rescindedPolicyIds.has(row.policy_event_id)) {
      continue;
    }
    if (row.derivation_policy === "retain") continue;
    for (const t of row.targets) {
      seeds.add(t);
      if (row.connector_revoke === true && !seedRevokeAttribution.has(t)) {
        const meta = scan.revokeMetaBySource.get(row.target_source);
        seedRevokeAttribution.set(t, {
          revoke_event_id: meta != null ? meta.revoke_event_id : (row.policy_event_id || null),
          target_source: row.target_source,
        });
      }
    }
  }

  const result = new Map();
  if (seeds.size === 0) {
    _orphanMapCache.set(key, result);
    return result;
  }

  // BFS from the seed set. Distance is in edges: seed itself is d=0 (the
  // excised event); direct descendant via derived_from is d=1; etc.
  // We DO put the seeds themselves in the map at distance 0 so that callers
  // asking "is this id orphaned by a transitive excise" get a consistent
  // answer for the directly-excised event as well. The seed is the user's
  // own excise target — fully suppressed at recall time by other paths
  // (excise removes the row from the projection); the d=0 entry is a
  // belt-and-suspenders guard.
  const visited = new Set();
  // R25.5 CRIT-2: per-node revoke attribution so the emission carries the
  // correct revoke_event_id even when multiple revokes seed overlapping
  // descendants. Map<memory_id, {revoke_event_id, target_source}>.
  // Seeds inherit their attribution from seedRevokeAttribution; descendants
  // inherit from their first BFS-parent (first-discovery wins, deterministic
  // on Set iteration order).
  const nodeRevokeAttribution = new Map();
  // Collect emissions inline; flush AFTER BFS+cap-warn+corroboration-rescue
  // so corroboration-rescued facts are NOT flagged stale (the rescue replaces
  // the orphan with a fresh non-revoked source; no drift to surface).
  const stalePending = [];
  // Frontier ring: { id, distance }. We use a plain array with a head index
  // so we do not pay the cost of Array.prototype.shift on large frontiers.
  const frontier = [];
  let head = 0;
  for (const s of seeds) {
    if (visited.has(s)) continue;
    visited.add(s);
    frontier.push({ id: s, distance: 0 });
    result.set(s, {
      distance_to_nearest_excised: 0,
      transitive_orphan: true,
      rescued_by_corroboration: false,
    });
    const attr = seedRevokeAttribution.get(s);
    if (attr != null) {
      nodeRevokeAttribution.set(s, attr);
      if (scan.salienceFacts.has(s)) {
        stalePending.push({ memory_id: s, attribution: attr });
      }
    }
    if (visited.size >= CAPS.TRANSITIVE_ORPHAN_DESCENDANTS_CAP) break;
  }

  let capExceeded = false;
  while (head < frontier.length) {
    const node = frontier[head++];
    if (node.distance >= CAPS.MAX_DERIVATION_DEPTH) continue;
    const kids = scan.reverseAdj.get(node.id);
    if (kids == null) continue;
    const parentAttr = nodeRevokeAttribution.get(node.id);
    for (const child of kids) {
      if (visited.has(child)) continue;
      if (visited.size >= CAPS.TRANSITIVE_ORPHAN_DESCENDANTS_CAP) {
        capExceeded = true;
        break;
      }
      visited.add(child);
      const childDistance = node.distance + 1;
      frontier.push({ id: child, distance: childDistance });
      result.set(child, {
        distance_to_nearest_excised: childDistance,
        transitive_orphan: true,
        rescued_by_corroboration: false,
      });
      if (parentAttr != null) {
        nodeRevokeAttribution.set(child, parentAttr);
        if (scan.salienceFacts.has(child)) {
          stalePending.push({ memory_id: child, attribution: parentAttr });
        }
      }
    }
    if (capExceeded) break;
  }

  if (capExceeded) {
    console.warn(
      `hard-gates: TRANSITIVE_ORPHAN_DESCENDANTS_CAP (${CAPS.TRANSITIVE_ORPHAN_DESCENDANTS_CAP}) ` +
        `reached during forward BFS from ${seeds.size} excise seed(s); ` +
        `returning partial coverage of ${result.size} entr(ies). ` +
        `policy.recall.transitive_orphan_cap_exceeded`,
    );
    // Emit the informational policy event so the audit channel records the
    // partial-coverage incident. Wrapped in try/catch because policy-events
    // can throw on disk-full / lock contention and recall MUST NOT fail on
    // the audit-emit path. The console.warn above is the operator's
    // immediate signal; the policy event is the durable audit record.
    try {
      let ledgerMtime = null;
      let ledgerSize = null;
      if (existsSync(ledgerPath)) {
        const st = statSync(ledgerPath);
        ledgerMtime = st.mtimeMs;
        ledgerSize = st.size;
      }
      appendPolicyEvent({
        kind: "policy.recall.transitive_orphan_cap_exceeded",
        seed_count: seeds.size,
        visited_count: result.size,
        cap: CAPS.TRANSITIVE_ORPHAN_DESCENDANTS_CAP,
        ledger_mtime: ledgerMtime,
        ledger_size: ledgerSize,
        attempted_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error(
        `hard-gates: failed to emit policy.recall.transitive_orphan_cap_exceeded: ${err.message}`,
      );
    }
  }

  // Corroboration rescue: for each orphan at distance >= 1, check the
  // projection. A descendant with a non-excised, non-orphan corroboration
  // target is rescued. Seeds (distance 0) are NOT rescuable — they are the
  // user's own excise targets.
  if (scan.corroborationByTarget.size > 0) {
    for (const [memId, info] of result) {
      if (info.distance_to_nearest_excised === 0) continue;
      const corrs = scan.corroborationByTarget.get(memId);
      if (corrs == null || corrs.length === 0) continue;
      let rescued = false;
      for (const c of corrs) {
        const ref = c.source_ref;
        if (ref == null || typeof ref !== "object") continue;
        // The corroboration's pointer is target_memory_id (per
        // architecture.md § policy.corroboration); fall back to a "source"
        // sub-field if the ledger writes that form. A rescue requires a
        // non-excised, non-orphan pointer.
        const tgt =
          typeof ref.target_memory_id === "string" && ref.target_memory_id !== ""
            ? ref.target_memory_id
            : typeof ref.source === "string"
              ? ref.source
              : null;
        if (tgt == null) continue;
        if (result.has(tgt)) continue; // pointer is itself in orphan map
        if (seeds.has(tgt)) continue;
        rescued = true;
        break;
      }
      if (rescued) {
        result.set(memId, {
          distance_to_nearest_excised: info.distance_to_nearest_excised,
          transitive_orphan: false,
          rescued_by_corroboration: true,
        });
      }
    }
  }

  // R25.5 CRIT-2: flush stale_post_revoke audit emissions for facts that are
  // (a) BFS-reachable from a connector_revoke seed, (b) carry features.salience,
  // and (c) were NOT rescued by corroboration. The rescue check uses the
  // freshly-updated result map. Idempotency: keyed on (fact_id, revoke_event_id);
  // suppressed for the lifetime of the process. Each emit is wrapped in try/catch
  // because policy-events can throw on disk-full / lock contention and recall
  // MUST NOT fail on the audit-emit path (mirrors transitive_orphan_cap_exceeded).
  for (const pending of stalePending) {
    const info = result.get(pending.memory_id);
    if (info == null) continue;
    if (info.rescued_by_corroboration === true) continue;
    const revokeId = pending.attribution.revoke_event_id || "unknown";
    const dedupKey = `${pending.memory_id}|${revokeId}`;
    if (_emittedStaleByKey.has(dedupKey)) continue;
    const salRec = scan.salienceFacts.get(pending.memory_id);
    const noveltyComponentWas = salRec != null ? salRec.novelty : null;
    try {
      appendPolicyEvent({
        kind: "policy.salience.stale_post_revoke",
        fact_id: pending.memory_id,
        target_source: pending.attribution.target_source,
        revoke_event_id: revokeId,
        novelty_component_was: noveltyComponentWas,
        discovered_at: new Date().toISOString(),
      });
      _emittedStaleByKey.add(dedupKey);
    } catch (err) {
      console.error(
        `hard-gates: failed to emit policy.salience.stale_post_revoke for ${pending.memory_id}: ${err.message}`,
      );
    }
  }

  _orphanMapCache.set(key, result);
  return result;
}

// ---------------------------------------------------------------------------
// derivationStatusForDistance: the depth-aware dampener.
// ---------------------------------------------------------------------------
// d=1 (direct orphan, v0 anchor)       -> 1.0 * 0.5 = 0.5 exact
// d=2                                  -> exp(-0.4) * 0.5 ≈ 0.3352
// d=3                                  -> exp(-0.8) * 0.5 ≈ 0.2247 -> floor 0.25
// d>=3                                 -> CAPS.DERIVATION_STATUS_ORPHAN_FLOOR
// d=0 (the excised event itself)       -> floor (the row is already removed
//                                          from the projection by other means;
//                                          this is a safety floor)
//
// Exported so applyHardGates and the multi-feature-score test fixtures can
// reuse the same canonical computation.
export function derivationStatusForDistance(d) {
  if (typeof d !== "number" || !Number.isFinite(d) || d < 0) {
    return CAPS.DERIVATION_STATUS_NORMAL;
  }
  if (d === 0) return CAPS.DERIVATION_STATUS_ORPHAN_FLOOR;
  const raw =
    Math.exp(-CAPS.DERIVATION_ORPHAN_LAMBDA * (d - 1)) *
    CAPS.DERIVATION_STATUS_ORPHAN;
  return raw < CAPS.DERIVATION_STATUS_ORPHAN_FLOOR
    ? CAPS.DERIVATION_STATUS_ORPHAN_FLOOR
    : raw;
}

// ---------------------------------------------------------------------------
// applyHardGates: per-candidate predicate mask + consent dampener + derivation
// status. Synchronous (no I/O); caller is expected to have pre-loaded the
// predicate list and excise-set via the loaders above.
// ---------------------------------------------------------------------------
// Returns Array<{
//   entry: IndexEntry,
//   predicate_mask: 0 | 1,
//   consent_dampener: number,
//   derivation_status: number,
//   dropped_reason: string | null
// }>
//
// Geometry selection: the vector DIMENSION is the model selector. The two
// embedding backends produce distinct, non-overlapping dims (4096 local /
// 3072 Gemini — rationale mirrored from recall.js's backfill-classifier
// note), so each predicate is evaluated against the candidate vector of the
// PREDICATE's own dim via _resolveGateVector below, and a cross-version
// (cross-dim) cosine is structurally impossible. opts.embedding_model_version
// remains a required non-empty string for back-compat with existing callers
// only — it no longer drives matching.
// _resolveGateVector: return the candidate's embedding whose dimension
// matches `dim`, else null. Checks the known dim-tagged fields in fixed
// order. Accepts plain arrays AND typed arrays (IndexEntry embeddings are
// Float32Array in-memory), mirroring the historical acceptance test:
// Array.isArray(v) || (v && typeof v.length === "number").
const GATE_VECTOR_FIELDS = ["embedding_4096", "embedding_3072", "embedding_768"];
function _resolveGateVector(entry, dim) {
  if (entry == null) return null;
  for (const field of GATE_VECTOR_FIELDS) {
    const v = entry[field];
    if (
      (Array.isArray(v) || (v && typeof v.length === "number")) &&
      v.length === dim
    ) {
      return v;
    }
  }
  return null;
}

function _isVectorLike(v) {
  return Array.isArray(v) || (v != null && typeof v.length === "number");
}

// ---------------------------------------------------------------------------
// predicateMaskForCandidate — PURE (no I/O) single-candidate predicate gate.
// ---------------------------------------------------------------------------
// The single source of truth for the predicate-exclusion decision, shared by
// applyHardGates Step 1 (batch path) and the RC post-vector-overlay reapply
// (recall.js wiring is a separate node; this module only EXPOSES + unit-tests
// the fn). Returns { masked: boolean, predicate_id: string|null }. A candidate
// is masked when ANY active predicate fires via EITHER channel (first match
// wins; deterministic on predicate input order):
//
//   (1) DENSE COSINE, in the predicate's own vector geometry. The candidate
//       vector is `resolvedVector` when its dim matches the predicate's dim
//       (RC passes the post-overlay embedding here); otherwise it falls back to
//       the candidate's stored same-dim embedding via _resolveGateVector. The
//       batch path passes resolvedVector=null and therefore always uses the
//       stored vector — byte-identical to the pre-refactor Step 1. cosine >
//       (pred.similarity_threshold ?? CAPS.PREDICATE_MATCH_COSINE_THRESHOLD):
//       legacy inline predicates without a threshold keep the global cap. A
//       cross-dim (cross-model) cosine stays structurally impossible.
//
//   (2) ENTITY OVERLAP, vector-independent. pred.context_entities ∩
//       entry.entities ≠ ∅ masks even when the candidate carries no same-dim
//       vector — so entity-only predicates and unembedded candidates still
//       suppress. Honors the contract's OR semantics: either channel suffices.
//
// No match => { masked: false, predicate_id: null }.
export function predicateMaskForCandidate(entry, resolvedVector, activePredicates) {
  if (entry == null) return { masked: false, predicate_id: null };
  const preds = Array.isArray(activePredicates) ? activePredicates : [];
  const candEntities = Array.isArray(entry.entities) ? entry.entities : [];
  for (let p = 0; p < preds.length; p++) {
    const pred = preds[p];
    if (!pred) continue;

    // Channel 2: entity overlap (independent of vector dim). Set intersection.
    const predEntities = Array.isArray(pred.context_entities)
      ? pred.context_entities
      : [];
    if (predEntities.length > 0 && candEntities.length > 0) {
      const [probe, lookup] =
        candEntities.length >= predEntities.length
          ? [predEntities, new Set(candEntities)]
          : [candEntities, new Set(predEntities)];
      for (const e of probe) {
        if (typeof e === "string" && lookup.has(e)) {
          return { masked: true, predicate_id: pred.predicate_id };
        }
      }
    }

    // Channel 1: dense cosine in the predicate's geometry.
    // Loader output carries `query_embedding`; legacy inline predicate objects
    // (old callers / tests) carry `query_embedding_3072`.
    const predVec = Array.isArray(pred.query_embedding)
      ? pred.query_embedding
      : pred.query_embedding_3072;
    if (!Array.isArray(predVec) || predVec.length === 0) continue;
    const candVec =
      _isVectorLike(resolvedVector) && resolvedVector.length === predVec.length
        ? resolvedVector
        : _resolveGateVector(entry, predVec.length);
    if (candVec == null) continue; // no same-dim candidate vector: skip.
    const cos = cosineSimilarity(predVec, candVec);
    const threshold =
      typeof pred.similarity_threshold === "number"
        ? pred.similarity_threshold
        : CAPS.PREDICATE_MATCH_COSINE_THRESHOLD;
    if (cos > threshold) {
      return { masked: true, predicate_id: pred.predicate_id };
    }
  }
  return { masked: false, predicate_id: null };
}

export function applyHardGates(candidates, opts) {
  if (!Array.isArray(candidates)) {
    throw new TypeError("applyHardGates: candidates must be an array");
  }
  if (opts == null || typeof opts !== "object") {
    throw new TypeError("applyHardGates: opts must be an object");
  }
  const activePredicates = Array.isArray(opts.activePredicates)
    ? opts.activePredicates
    : [];
  const exciseSet =
    opts.derivation_excise_set instanceof Set
      ? opts.derivation_excise_set
      : new Set();
  // transitive_orphan_map (new path) wins over derivation_excise_set (v0
  // back-compat). When BOTH are present, the map's depth-aware dampener
  // governs; the v0 set is ignored. When NEITHER is present, the gate is a
  // no-op (NORMAL for everything). When ONLY the set is supplied, we
  // synthesize a d=1 entry for every candidate whose derived_from
  // intersects the set — i.e. exactly v0 behavior.
  const orphanMap =
    opts.transitive_orphan_map instanceof Map
      ? opts.transitive_orphan_map
      : null;
  const modelVersion = opts.embedding_model_version;
  if (typeof modelVersion !== "string" || modelVersion === "") {
    throw new TypeError(
      "applyHardGates: opts.embedding_model_version must be a non-empty string",
    );
  }

  const out = new Array(candidates.length);
  for (let i = 0; i < candidates.length; i++) {
    const entry = candidates[i];
    let predicate_mask = 1;
    let dropped_reason = null;

    // Step 1: predicate exclusion — delegated to the shared, PURE
    // predicateMaskForCandidate (single source of truth reused by RC's
    // post-overlay reapply). resolvedVector=null on the batch path, so each
    // predicate resolves the candidate vector per-dim via _resolveGateVector
    // (never a cross-dim cosine) and the per-predicate similarity_threshold OR
    // entity-overlap channel decides. dropped_reason keeps the
    // predicate_excluded:<id> shape.
    if (entry != null) {
      const { masked, predicate_id } = predicateMaskForCandidate(
        entry,
        null,
        activePredicates,
      );
      if (masked) {
        predicate_mask = 0;
        dropped_reason = `predicate_excluded:${predicate_id}`;
      }
    }

    // Step 2: consent dampener.
    // "consent_blocked" is the stronger DROP state; everything else maps to
    // the per-basis multiplier table.
    let consent_dampener = CAPS.CONSENT_DAMPENER_FIRST_PARTY;
    const basis = entry ? entry.consent_basis : undefined;
    if (basis === "consent_blocked") {
      predicate_mask = 0;
      if (dropped_reason == null) dropped_reason = "consent_blocked";
    } else if (basis === "third_party_inferred") {
      consent_dampener = CAPS.CONSENT_DAMPENER_THIRD_PARTY_INFERRED;
    } else if (basis === "first_party") {
      consent_dampener = CAPS.CONSENT_DAMPENER_FIRST_PARTY;
    } else {
      // unknown / unset / future enum value: keep at 1.0 per spec.
      consent_dampener = CAPS.CONSENT_DAMPENER_FIRST_PARTY;
    }

    // Step 3: derivation orphan flag (depth-aware via transitive_orphan_map
    // when supplied; falls back to v0 direct-ancestor check otherwise).
    let derivation_status = CAPS.DERIVATION_STATUS_NORMAL;
    let derivation_distance = null;
    if (entry != null) {
      if (orphanMap != null) {
        const info =
          typeof entry.memory_id === "string"
            ? orphanMap.get(entry.memory_id)
            : null;
        if (info != null && info.transitive_orphan === true) {
          derivation_distance = info.distance_to_nearest_excised;
          derivation_status = derivationStatusForDistance(derivation_distance);
        }
      } else if (exciseSet.size > 0 && Array.isArray(entry.derived_from)) {
        for (let k = 0; k < entry.derived_from.length; k++) {
          const ancestor = entry.derived_from[k];
          if (typeof ancestor === "string" && exciseSet.has(ancestor)) {
            derivation_status = CAPS.DERIVATION_STATUS_ORPHAN;
            derivation_distance = 1;
            break;
          }
        }
      }
    }

    out[i] = {
      entry,
      predicate_mask,
      consent_dampener,
      derivation_status,
      derivation_distance,
      dropped_reason,
    };
  }
  return out;
}
