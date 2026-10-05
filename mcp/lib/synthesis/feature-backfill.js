// feature-backfill.js — W3-CCS BACKFILL tier (KEYSTONE).
// (F-CCS-BACKFILL-engine — F-CCS-FOUNDATION-feature-backfill-policy)
//
// Authoritative spec:
//   mcp/docs/specs/ccs/feature-backfill-policy.md
//
// MISSION
//   Retroactively stamp the W2-W6 extractor stack outputs onto historical
//   facts that were promoted BEFORE the cascade-side stampers existed.
//   The 83 legacy facts on memory.jsonl carry features = {embedding,
//   salience} only — no entities[], no time_anchors[], no valence, no
//   episodicity. Per thesis #1 (the ledger is permanent) we MUST NOT
//   rewrite those rows in place. Instead we append ONE
//   policy.feature_backfill event per fact with the extractor outputs in a
//   features_overlay; the recall-time consumer overlays on read.
//
// SINGLE PRODUCER
//   This file is the SOLE writer of `policy_kind:"feature_backfill"` rows
//   under mcp/lib/. Enforced by
//   mcp/test/synthesis/single-producer-feature-backfill.test.mjs.
//
// IDEMPOTENCE (spec §6)
//   The pair {target_fact_id, backfill_version} is the dedupe key. Before
//   emitting an event for a fact, the engine:
//     1. Scans the latest-backfill map for target_fact_id.
//     2. If no entry exists → backfill_version: 1.
//     3. If entry exists with version N:
//        a. Compute the proposed overlay.
//        b. Byte-compare against existing overlay (canonical JSON).
//        c. Equal → SKIP (no-op).
//        d. Different → version N+1, emit.
//
// DEFENSIVE DEGRADATION
//   Extractor failure on a single fact → skip + log + count error; the
//   walk continues. Ledger append failure → return error count, NEVER
//   throw back to the caller. Matches the W2 / W9 / W11 emitter
//   discipline.
//
// BOUNDED LEDGER READS (s3-feature-backfill-bounded)
//   The ledger is read in TWO streamed passes (loadLatestBackfillMap then
//   collectBackfillCandidates), never as one string and never with the
//   whole fact set held in memory. The live memory.jsonl is 3,054,950,767
//   bytes against a 536,870,888-byte max JS string, and its 1.5M fact rows
//   cost ~4.20 GB of heap against a 4,288 MB default limit — a whole-file
//   read threw into a bare catch (engine saw a zero-row ledger) and an
//   unbounded stream would OOM the cron caller. Read failures are
//   classified, not conflated with "empty": missing ledger → clean zeros;
//   unreadable ledger → logged + counted, fail CLOSED on pass 1 (a partial
//   backfill map would append duplicate rows) and fail OPEN on pass 2 (a
//   partial candidate list can only emit fewer rows, never wrong ones).
//
// CONTRACT — runBackfill({ledgerPath, sinceVersion?, factIds?, dryRun?})
//   Returns {facts_inspected, backfill_events_emitted, skipped_noop,
//   errors}. dryRun=true performs all computation but writes nothing.

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

import { serverTs } from "../envelope.js";
// s3-feature-backfill-bounded: the ledger is read line-by-line through the
// WU-B1 streaming primitive. It reads 64 KiB chunks via readSync with a
// StringDecoder for UTF-8 chunk seams, NEVER materialises the file, never
// throws, closes its fd in a finally, and reports fs failures on
// counts.readError (ENOENT => zeros with readError null; every other errno
// => readError set). See _ledger-stream.js:84-127 for the full contract.
import { streamLedgerLines } from "./_ledger-stream.js";
import {
  extractEntities,
  ENTITY_EXTRACTOR_VERSION,
  ENTITY_SOURCE_SCOPES,
} from "./entity-extractor.js";
import {
  resolveTimeAnchors,
  TIME_ANCHOR_RESOLVER_VERSION,
} from "./time-anchor-resolver.js";
import {
  scoreValence,
  MODEL_VERSION as VALENCE_SCORER_VERSION,
} from "./valence-scorer.js";
import {
  computeFromFeatures,
  EPISODICITY_VERSION,
} from "./episodicity-scorer.js";

// ---------------------------------------------------------------------------
// PUBLIC CONSTANTS — single source of truth. NEVER inline
// "feature_backfill" elsewhere under mcp/lib/ (single-producer CI guard).
// ---------------------------------------------------------------------------

/** Module version stamp — increment on writer-side semantic changes. */
export const FEATURE_BACKFILL_VERSION = "v0.1.0";

/** Schema version stamped into every emitted row. */
export const FEATURE_BACKFILL_SCHEMA_VERSION = "v1";

/** The policy_kind discriminator stamped into every backfill row. The
 *  single-producer CI test asserts only this file writes it as a quoted
 *  value under mcp/lib/. */
export const FEATURE_BACKFILL_KIND = "feature_backfill";

/** Frozen module-level capability snapshot. BATCH_SIZE caps per-tick
 *  drain count; MAX_WALL_MS bounds wall time for a single runBackfill
 *  invocation. */
export const BACKFILL_CAPS = Object.freeze({
  BATCH_SIZE: 50,
  MAX_WALL_MS: 30000,
  FEATURE_BACKFILL_KIND,
  FEATURE_BACKFILL_VERSION,
  FEATURE_BACKFILL_SCHEMA_VERSION,
});

/** Closed v1 overlay channel set (spec §3.2). Engine refuses to write
 *  unknown channels; consumer ignores unknowns. */
export const OVERLAY_CHANNELS_V1 = Object.freeze([
  "entities",
  "time_anchors",
  "valence",
  "episodicity",
]);

/** Emitter module identifier — written into row.emitter_module. */
const EMITTER_MODULE = "feature-backfill";

/** Default source scope used when a fact row's source_refs[0].source is
 *  outside the closed ENTITY_SOURCE_SCOPES enum. Skip extraction in that
 *  case (return empty entities). */
const SUPPORTED_SOURCE_SCOPES = new Set(ENTITY_SOURCE_SCOPES);

// ---------------------------------------------------------------------------
// File-system constants — mirror W9 / W11 / W2-CCS writer discipline.
// ---------------------------------------------------------------------------

const LEDGER_O_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_APPEND |
  fsConstants.O_CREAT |
  fsConstants.O_NOFOLLOW;

const LEDGER_FILE_MODE = 0o600;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function generateRowId() {
  // mem_<16hex> — matches the prefix used by recall-feedback-emitter,
  // forgetting-propagation, embed-backfill-worker. The recall layer
  // does not key off this id; it exists for ledger-level audit join.
  return "mem_" + randomBytes(8).toString("hex");
}

function ensureLedgerDir(ledgerPath) {
  try {
    const dir = dirname(ledgerPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  } catch {
    // Best-effort; appendOneRow will surface real ENOENT.
  }
}

function fsyncDir(dir) {
  try {
    const dirFd = openSync(dir, fsConstants.O_RDONLY);
    try {
      fsyncSync(dirFd);
    } finally {
      try {
        closeSync(dirFd);
      } catch {
        // ignore
      }
    }
  } catch (err) {
    if (err && err.code !== "EISDIR" && err.code !== "EINVAL") {
      // non-fatal — bytes already fsync'd to file.
    }
  }
}

function appendOneRow(ledgerPath, row) {
  ensureLedgerDir(ledgerPath);
  const bytes = Buffer.from(JSON.stringify(row) + "\n", "utf8");
  const fd = openSync(ledgerPath, LEDGER_O_FLAGS, LEDGER_FILE_MODE);
  try {
    let written = 0;
    while (written < bytes.length) {
      written += writeSync(fd, bytes, written, bytes.length - written);
    }
    fsyncSync(fd);
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
  }
  fsyncDir(dirname(ledgerPath));
}

/**
 * Canonical JSON of a features_overlay sub-object (deterministic key
 * order from the v1 closed set). Used for byte-equality dedupe (§6.1).
 */
function canonicalOverlayJson(overlay) {
  if (overlay == null || typeof overlay !== "object") return "{}";
  const out = {};
  for (const channel of OVERLAY_CHANNELS_V1) {
    if (overlay[channel] !== undefined) {
      out[channel] = overlay[channel];
    }
  }
  return JSON.stringify(out);
}

/** Log one line without ever letting a logger failure escape (the module's
 *  DEFENSIVE DEGRADATION contract — see header). */
function logError(message) {
  try {
    console.error(message);
  } catch {
    // logger throws don't propagate
  }
}

/**
 * PASS 1 — latest-backfill map.
 *
 * One streamed pass over the ledger retaining ONLY rows where
 *   kind === "policy" && policy_kind === FEATURE_BACKFILL_KIND &&
 *   typeof target_fact_id === "string"
 * reduced latest-wins per spec §4.1.4: max backfill_version, tie-break on
 * ts, then on id. The reduction below is behaviourally verbatim with the
 * pre-streaming loader — mcp/lib/recall/multi-feature-score.js's
 * buildLatestBackfillMap independently re-derives the identical rule at
 * query time and the two MUST agree, so this ordering is frozen.
 *
 * RETENTION: bounded by the number of feature_backfill policy rows on the
 * ledger — 83 on the live 3.05 GB / 1,518,834-row memory.jsonl. Fact rows
 * are never held.
 *
 * @returns {{ latestBackfillByFactId: Map<string, object>, readError: string|null }}
 *   readError is null on a clean read AND on a genuinely missing ledger
 *   (ENOENT keeps the cold-start "missing === empty" contract); it carries
 *   the fs error message for any other errno. Never throws.
 */
function loadLatestBackfillMap(ledgerPath) {
  const latestBackfillByFactId = new Map();
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) {
    return { latestBackfillByFactId, readError: null };
  }
  // onRow must be TOTAL: streamLedgerLines never throws, but an onRow throw
  // DOES propagate by design. Every access below is type-guarded.
  const counts = streamLedgerLines(ledgerPath, (row) => {
    if (row == null || typeof row !== "object") return;
    if (row.kind !== "policy") return;
    if (row.policy_kind !== FEATURE_BACKFILL_KIND) return;
    if (typeof row.target_fact_id !== "string") return;
    const tgt = row.target_fact_id;
    const prior = latestBackfillByFactId.get(tgt);
    if (prior == null) {
      latestBackfillByFactId.set(tgt, row);
      return;
    }
    // Latest wins by backfill_version, then ts, then id (spec §4.1.4).
    const priorV = typeof prior.backfill_version === "number"
      ? prior.backfill_version
      : 0;
    const rowV = typeof row.backfill_version === "number"
      ? row.backfill_version
      : 0;
    if (rowV > priorV) {
      latestBackfillByFactId.set(tgt, row);
    } else if (rowV === priorV) {
      const priorTs = typeof prior.ts === "string" ? prior.ts : "";
      const rowTs = typeof row.ts === "string" ? row.ts : "";
      if (rowTs > priorTs) {
        latestBackfillByFactId.set(tgt, row);
      } else if (rowTs === priorTs) {
        const priorId = typeof prior.id === "string" ? prior.id : "";
        const rowId = typeof row.id === "string" ? row.id : "";
        if (rowId > priorId) {
          latestBackfillByFactId.set(tgt, row);
        }
      }
    }
  });
  return {
    latestBackfillByFactId,
    readError: counts.readError != null ? counts.readError : null,
  };
}

/**
 * PASS 2 — bounded candidate collection.
 *
 * One streamed pass over kind:"fact" rows IN LEDGER ORDER, retaining a fact
 * row ONLY when needsBackfill() says it has work to do, and stopping the
 * moment `limit` candidates have been collected.
 *
 * WHY THE BOUND IS THE WHOLE POINT
 *   The pre-streaming loader retained EVERY fact row in a Map<id,row>. On
 *   the live ledger 1,515,956 of 1,518,834 rows are kind:"fact", measured
 *   at 2,769 bytes of heap per retained row => ~4.20 GB against Node's
 *   default heap_size_limit of 4,288 MB. The only production caller,
 *   scripts/run-feature-backfill.mjs, sets no --max-old-space-size. Simply
 *   swapping the whole-file read for a stream would have traded a loud
 *   917 ms ERR_STRING_TOO_LONG throw for a fatal OOM. At NO point may more
 *   than `limit` fact rows be held here.
 *
 * DELIBERATE SEMANTIC CHANGE — first-wins instead of last-wins
 *   The old factRowsById Map deduped repeated fact ids LAST-WINS (a later
 *   line overwrote an earlier one). A bounded streaming pass is FIRST-WINS
 *   in ledger order, because preserving last-wins requires retaining every
 *   fact row — precisely the unboundedness being removed. This is
 *   empirically inert today: the live ledger has 1,515,993 fact rows and
 *   1,515,993 unique fact ids, i.e. ZERO duplicates (re-measured read-only
 *   at 3,058,232,133 bytes / 1,518,877 rows). The worst future case
 *   is one redundant emit for a duplicated id, which the canonicalOverlayJson
 *   byte-compare in buildBackfillRow collapses to a skipped_noop.
 *
 * factsInspected mirrors the old break-based accounting exactly: the cap is
 * checked BEFORE the counter increments, so once capped no further fact is
 * counted (old code: `if (workCount >= BATCH_SIZE) break;` ahead of
 * `result.facts_inspected += 1`).
 *
 * @returns {{ candidates: Array<{factId: string, factRow: object, existing: object|null}>,
 *             factsInspected: number, readError: string|null }}
 */
function collectBackfillCandidates(
  ledgerPath,
  {
    latestBackfillByFactId = new Map(),
    sinceVersion,
    factIdFilter = null,
    limit = BACKFILL_CAPS.BATCH_SIZE,
  } = {},
) {
  const candidates = [];
  let factsInspected = 0;
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) {
    return { candidates, factsInspected, readError: null };
  }
  const cap =
    Number.isInteger(limit) && limit > 0 ? limit : BACKFILL_CAPS.BATCH_SIZE;
  // Bounded-retention idiom, verbatim in shape from
  // mcp/lib/recall/index-cache.js loadLedger: a `capped` flag, an immediate
  // return as the first line of onRow, and a loud warn when the cap trips.
  let capped = false;
  const counts = streamLedgerLines(ledgerPath, (row) => {
    if (capped) return;
    if (row == null || typeof row !== "object") return;
    if (row.kind !== "fact") return;
    if (typeof row.id !== "string") return;
    if (factIdFilter != null && !factIdFilter.has(row.id)) return;
    factsInspected += 1;
    const existing = latestBackfillByFactId.get(row.id) || null;
    if (!needsBackfill(row, existing, sinceVersion)) return;
    candidates.push({ factId: row.id, factRow: row, existing });
    if (candidates.length >= cap) capped = true;
  });
  if (capped) {
    try {
      console.warn(
        `feature-backfill: candidate scan hit the ${cap}-row batch cap on ${ledgerPath}; ` +
          "collecting this tick's batch and deferring the remaining bare facts " +
          "to the next run (retention is bounded by design).",
      );
    } catch {
      // logger throws don't propagate
    }
  }
  return {
    candidates,
    factsInspected,
    readError: counts.readError != null ? counts.readError : null,
  };
}

/**
 * TEST-ONLY back-compat shim. runBackfill no longer uses this — it calls
 * loadLatestBackfillMap + collectBackfillCandidates directly. Kept because
 * mcp/test/synthesis/feature-backfill.test.mjs exercises the §4.1 latest-wins
 * reduction through __internal.streamLedgerState(...).latestBackfillByFactId.
 *
 * EXPLICITLY BOUNDED: factRowsById carries at most BACKFILL_CAPS.BATCH_SIZE
 * entries (the candidate batch), never the whole fact set — a shim is not a
 * licence to reintroduce the ~4.20 GB retention this node removed.
 */
function streamLedgerState(ledgerPath) {
  const { latestBackfillByFactId } = loadLatestBackfillMap(ledgerPath);
  const { candidates } = collectBackfillCandidates(ledgerPath, {
    latestBackfillByFactId,
    limit: BACKFILL_CAPS.BATCH_SIZE,
  });
  const factRowsById = new Map();
  for (const c of candidates) factRowsById.set(c.factId, c.factRow);
  return { factRowsById, latestBackfillByFactId };
}

/**
 * Decide whether a fact row needs backfill (spec §5.1):
 *   - features.entities undefined → YES (the 83-fact case)
 *   - features.entity_extractor_version < current → YES (extractor drift)
 *   - sinceVersion supplied AND existing backfill_version < sinceVersion → YES
 */
function needsBackfill(factRow, existingBackfill, sinceVersion) {
  if (factRow == null || typeof factRow !== "object") return false;
  const features =
    factRow.features != null && typeof factRow.features === "object"
      ? factRow.features
      : null;

  // sinceVersion gate — operator-driven re-stamp. Checked first so it
  // overrides the "already-covered" early-exit below.
  if (typeof sinceVersion === "number" && Number.isFinite(sinceVersion)) {
    const existingV =
      existingBackfill != null &&
      typeof existingBackfill.backfill_version === "number"
        ? existingBackfill.backfill_version
        : 0;
    if (existingV < sinceVersion) return true;
  }

  // EARLY EXIT — already covered by an up-to-date backfill row. This MUST
  // be checked BEFORE inspecting the fact row's features.entities slot,
  // because the historical 83-fact case is precisely "features.entities
  // is undefined AND a fresh backfill exists" — the next-tick batch
  // budget must not be consumed re-processing facts we already covered.
  if (existingBackfill != null) {
    const ev =
      existingBackfill.extractor_versions != null &&
      typeof existingBackfill.extractor_versions === "object"
        ? existingBackfill.extractor_versions
        : {};
    if (
      ev.entity_extractor === ENTITY_EXTRACTOR_VERSION &&
      ev.time_anchor_extractor === TIME_ANCHOR_RESOLVER_VERSION &&
      ev.valence_scorer === VALENCE_SCORER_VERSION &&
      ev.episodicity_scorer === EPISODICITY_VERSION
    ) {
      return false;
    }
    // Backfill exists but at least one extractor has drifted — needs
    // a fresh extraction.
    return true;
  }

  if (features == null) return true;
  // Missing entities slot → bare fact (the 83 historicals).
  if (features.entities === undefined) return true;
  // Empty entities array on a row that the W3 cascade would have populated
  // counts as "extractor never ran" only when there's no
  // entity_extractor_version stamped (legacy bare rows).
  if (
    !Array.isArray(features.entities) &&
    features.entity_extractor_version == null
  ) {
    return true;
  }
  // Drift: stamped version differs from current.
  if (
    typeof features.entity_extractor_version === "string" &&
    features.entity_extractor_version !== ENTITY_EXTRACTOR_VERSION
  ) {
    return true;
  }
  return false;
}

/**
 * Run the W2-W6 extractor stack over a fact row + its connector
 * structured_features (when present). Returns
 *   { overlay, extractor_versions, confidence }
 * or { error } on any extractor throw. Pure-functional (no I/O).
 *
 * Mirrors the cascade-time stamping logic in distill-promote-fact.js
 * appendFactRow (text-extracted entities + structured-features merge +
 * row-ts time anchor + episodicity scoring), reproduced here so the
 * backfill projection is conceptually identical to what a re-promote
 * would have produced.
 */
function runExtractorStack(factRow) {
  const result = {
    overlay: {},
    extractor_versions: {},
    confidence: 1.0,
    error: null,
  };
  const features =
    factRow.features != null && typeof factRow.features === "object"
      ? factRow.features
      : {};
  const content = typeof factRow.content === "string" ? factRow.content : "";

  // Source scope — derived from source_refs[0].source. Required for the
  // entity extractor's canonical_id scope. Outside-of-enum sources skip
  // text-extraction (the structured-features merge is still attempted).
  const firstRef =
    Array.isArray(factRow.source_refs) && factRow.source_refs.length > 0
      ? factRow.source_refs[0]
      : null;
  const sourceForExtract =
    firstRef != null && typeof firstRef.source === "string"
      ? firstRef.source
      : null;

  // ---- W3 entities -------------------------------------------------------
  let entities = [];
  if (
    sourceForExtract != null &&
    SUPPORTED_SOURCE_SCOPES.has(sourceForExtract) &&
    content.length > 0
  ) {
    try {
      const r = extractEntities(content, {
        source: sourceForExtract,
        language: "en",
      });
      if (r && Array.isArray(r.entities)) entities = r.entities;
      result.extractor_versions.entity_extractor = ENTITY_EXTRACTOR_VERSION;
    } catch (err) {
      // Defensive: degrade this channel only.
      try {
        console.error(
          `feature-backfill: entity extraction failed for ${factRow.id}: ${err && err.message ? err.message : String(err)}`,
        );
      } catch {
        // logger throws don't propagate
      }
      result.confidence = Math.min(result.confidence, 0.5);
    }
  } else {
    // No usable source scope — still stamp the version so the overlay
    // signals "extractor ran" with an empty result (consumer sees empty
    // entities, additive branch collapses to 0 — same as cascade-time
    // empty-source rows).
    result.extractor_versions.entity_extractor = ENTITY_EXTRACTOR_VERSION;
  }
  // Merge connector structured_features.entities (per W2-CCS cascade
  // merge logic in distill-promote-fact.js §714-770). structured wins on
  // canonical_id collision.
  const structured =
    factRow.structured_features != null &&
    typeof factRow.structured_features === "object" &&
    !Array.isArray(factRow.structured_features)
      ? factRow.structured_features
      : null;
  if (structured != null) {
    const structuredEntities = Array.isArray(structured.entities)
      ? structured.entities
      : [];
    if (structuredEntities.length > 0) {
      const byId = new Map();
      for (const se of structuredEntities) {
        if (
          se != null &&
          typeof se === "object" &&
          typeof se.canonical_id === "string" &&
          se.canonical_id.length > 0
        ) {
          byId.set(se.canonical_id, se);
        }
      }
      for (const te of entities) {
        if (
          te != null &&
          typeof te === "object" &&
          typeof te.canonical_id === "string" &&
          te.canonical_id.length > 0 &&
          !byId.has(te.canonical_id)
        ) {
          byId.set(te.canonical_id, te);
        }
      }
      entities = [...byId.values()];
    }
  }
  result.overlay.entities = entities;

  // ---- W4 time_anchors --------------------------------------------------
  let timeAnchors = [];
  // Row-ts as structural anchor (per F-CCS-CASCADE-row-ts-as-anchor in
  // distill-promote-fact.js §667-711). Use created_at when present,
  // fallback to ts.
  const promotedAt =
    (typeof factRow.created_at === "string" && factRow.created_at) ||
    (typeof factRow.ts === "string" && factRow.ts) ||
    null;
  if (promotedAt) {
    timeAnchors.push({
      kind: "absolute",
      instant_iso: promotedAt,
      raw_phrase: null,
      structural: true,
      stamped_by: "feature-backfill:row-ts",
    });
  }
  // Text-extracted anchors.
  if (content.length > 0) {
    try {
      const r = resolveTimeAnchors(content, { now: promotedAt || serverTs() });
      if (r && Array.isArray(r.anchors)) {
        for (const a of r.anchors) timeAnchors.push(a);
      }
      result.extractor_versions.time_anchor_extractor = TIME_ANCHOR_RESOLVER_VERSION;
    } catch (err) {
      try {
        console.error(
          `feature-backfill: time-anchor resolution failed for ${factRow.id}: ${err && err.message ? err.message : String(err)}`,
        );
      } catch {
        // ignore
      }
      result.confidence = Math.min(result.confidence, 0.5);
    }
  } else {
    result.extractor_versions.time_anchor_extractor = TIME_ANCHOR_RESOLVER_VERSION;
  }
  // Merge connector structured_features.time_anchors.
  if (structured != null) {
    const structuredAnchors = Array.isArray(structured.time_anchors)
      ? structured.time_anchors
      : [];
    if (structuredAnchors.length > 0) {
      const dedupeKey = (a) => {
        if (a == null || typeof a !== "object") return "";
        const kind = typeof a.kind === "string" ? a.kind : "";
        const iso =
          a.parsed && typeof a.parsed === "object" &&
          typeof a.parsed.iso === "string"
            ? a.parsed.iso
            : typeof a.instant_iso === "string"
              ? a.instant_iso
              : typeof a.raw_phrase === "string"
                ? a.raw_phrase
                : "";
        return `${kind}|${iso}`;
      };
      const byKey = new Map();
      for (const sa of structuredAnchors) {
        const k = dedupeKey(sa);
        if (k !== "") byKey.set(k, sa);
      }
      for (const ta of timeAnchors) {
        const k = dedupeKey(ta);
        if (k !== "" && !byKey.has(k)) byKey.set(k, ta);
      }
      timeAnchors = [...byKey.values()];
    }
  }
  result.overlay.time_anchors = timeAnchors;

  // ---- W5 valence -------------------------------------------------------
  if (content.length > 0) {
    try {
      const v = scoreValence(content);
      if (v != null && typeof v.sign === "number") {
        // Store the scalar sign in [-1, +1]; spec §3 valence channel is a
        // single number (the recall-side scorer's valenceCompat reads a
        // scalar).
        result.overlay.valence = v.sign;
        result.extractor_versions.valence_scorer = VALENCE_SCORER_VERSION;
      }
    } catch (err) {
      try {
        console.error(
          `feature-backfill: valence scoring failed for ${factRow.id}: ${err && err.message ? err.message : String(err)}`,
        );
      } catch {
        // ignore
      }
      result.confidence = Math.min(result.confidence, 0.5);
    }
  }

  // ---- W6 episodicity ---------------------------------------------------
  // Compose a synthetic features block from what we just extracted so
  // computeFromFeatures sees the same inputs the cascade would have given
  // it at promote time.
  try {
    const synthFeatures = {
      entities: result.overlay.entities || [],
      time_anchors: result.overlay.time_anchors || [],
      // valence sub-object form expected by computeFromFeatures (it reads
      // .magnitude). The scoreValence result is already an object on the
      // intermediate path; recompute the magnitude defensively.
      valence:
        result.overlay.valence != null
          ? {
              sign: result.overlay.valence,
              magnitude: Math.abs(result.overlay.valence),
              source: "lexicon",
            }
          : null,
      corroboration_count: 0,
    };
    const ep = computeFromFeatures(synthFeatures);
    if (typeof ep === "number" && Number.isFinite(ep)) {
      result.overlay.episodicity = ep;
      result.extractor_versions.episodicity_scorer = EPISODICITY_VERSION;
    }
  } catch (err) {
    try {
      console.error(
        `feature-backfill: episodicity scoring failed for ${factRow.id}: ${err && err.message ? err.message : String(err)}`,
      );
    } catch {
      // ignore
    }
    result.confidence = Math.min(result.confidence, 0.5);
  }

  // Drop any overlay channel that we never managed to produce (the
  // spec's "absent channel" semantic per §4.3: undefined → consumer
  // preserves the original).
  if (result.overlay.entities === undefined) delete result.overlay.entities;
  if (result.overlay.time_anchors === undefined) {
    delete result.overlay.time_anchors;
  }
  if (result.overlay.valence === undefined) delete result.overlay.valence;
  if (
    result.overlay.episodicity === undefined ||
    !Number.isFinite(result.overlay.episodicity)
  ) {
    delete result.overlay.episodicity;
  }

  // Validate against closed v1 channel set (spec §3.2). Refuse to emit a
  // row containing an unknown channel.
  for (const k of Object.keys(result.overlay)) {
    if (!OVERLAY_CHANNELS_V1.includes(k)) {
      result.error = `unknown overlay channel '${k}' (closed v1 set: ${OVERLAY_CHANNELS_V1.join(",")})`;
      return result;
    }
  }

  return result;
}

/**
 * Build a single FeatureBackfillEvent row from the extractor outputs and
 * the existing backfill state. Returns the row OR null if the byte-equal
 * idempotence check (§6.1) says skip.
 */
function buildBackfillRow({
  factRow,
  extractorResult,
  existingBackfill,
}) {
  const overlay = extractorResult.overlay;
  const proposedCanonical = canonicalOverlayJson(overlay);
  // Idempotence (spec §6.1): byte-equal vs existing latest → no-op.
  if (existingBackfill != null) {
    const existingCanonical = canonicalOverlayJson(
      existingBackfill.features_overlay,
    );
    if (proposedCanonical === existingCanonical) {
      return null;
    }
  }
  const nextVersion =
    existingBackfill != null &&
    typeof existingBackfill.backfill_version === "number"
      ? existingBackfill.backfill_version + 1
      : 1;
  const row = {
    id: generateRowId(),
    ts: serverTs(),
    kind: "policy",
    policy_kind: FEATURE_BACKFILL_KIND,
    schema_version: FEATURE_BACKFILL_SCHEMA_VERSION,
    target_fact_id: factRow.id,
    features_overlay: overlay,
    backfill_version: nextVersion,
    extractor_versions: extractorResult.extractor_versions,
    emitter_module: EMITTER_MODULE,
    emitter_version: FEATURE_BACKFILL_VERSION,
    provenance: {
      agent_id: "feature-backfill-daemon",
      conversation_id: null,
      confidence: extractorResult.confidence,
    },
  };
  return row;
}

// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------

/**
 * Walk a memory.jsonl ledger; for each fact whose features are missing or
 * stale per needsBackfill(), run the W2-W6 extractor stack and append ONE
 * policy.feature_backfill row carrying the overlay. Idempotent: re-running
 * with no extractor changes is a no-op (byte-equal overlay → skip).
 *
 * @param {object} opts
 * @param {string} opts.ledgerPath - absolute path to memory.jsonl
 * @param {number} [opts.sinceVersion] - re-stamp facts whose existing
 *   backfill_version is below this value
 * @param {string[]} [opts.factIds] - restrict to these target fact ids
 * @param {boolean} [opts.dryRun] - perform extraction but write nothing
 *
 * @returns {Promise<{
 *   facts_inspected: number,
 *   backfill_events_emitted: number,
 *   skipped_noop: number,
 *   errors: number,
 *   dry_run: boolean,
 * }>}
 */
export async function runBackfill({
  ledgerPath,
  sinceVersion,
  factIds,
  dryRun = false,
} = {}) {
  const result = {
    facts_inspected: 0,
    backfill_events_emitted: 0,
    skipped_noop: 0,
    errors: 0,
    dry_run: dryRun === true,
  };
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) {
    return result;
  }
  // ---- PASS 1: latest-backfill map. FAIL CLOSED. ------------------------
  // A truncated backfill map is not merely lossy, it is DANGEROUS: every
  // already-covered fact would look bare, needsBackfill(factRow, null, ...)
  // returns true, and buildBackfillRow has no existing overlay to
  // byte-compare against so it cannot return null — the run would append
  // DUPLICATE policy rows to the ledger. On any read error we log, count,
  // and return without ever entering the emit loop.
  const { latestBackfillByFactId, readError: mapReadError } =
    loadLatestBackfillMap(ledgerPath);
  if (mapReadError !== null) {
    logError(
      `feature-backfill: latest-backfill scan of ${ledgerPath} failed (${mapReadError}); ` +
        "an unreadable ledger is NOT an empty ledger — refusing to emit, " +
        "because a partial backfill map would append duplicate policy rows",
    );
    result.errors += 1;
    return result;
  }

  // Filter set: factIds restricts to a subset; else iterate every fact.
  const factIdFilter =
    Array.isArray(factIds) && factIds.length > 0 ? new Set(factIds) : null;

  // ---- PASS 2: bounded candidate collection. FAIL OPEN. -----------------
  // Per-tick batching: only facts that trigger actual extractor work count
  // toward BATCH_SIZE. needsBackfill=false facts are cheap (no extractor
  // invoke, no ledger I/O) and counting them would force a multi-tick drain
  // on a large ledger even when only a handful of facts remain bare.
  // A truncated candidate list can only yield FEWER emits, never wrong
  // ones, so a read error here is logged and counted but the partial batch
  // still proceeds (mirrors reconstruction-emitter's scanLedgerLines:
  // "an unreadable ledger is NOT an empty ledger", then continues).
  const { candidates, factsInspected, readError: scanReadError } =
    collectBackfillCandidates(ledgerPath, {
      latestBackfillByFactId,
      sinceVersion,
      factIdFilter,
      limit: BACKFILL_CAPS.BATCH_SIZE,
    });
  result.facts_inspected = factsInspected;
  if (scanReadError !== null) {
    logError(
      `feature-backfill: candidate scan of ${ledgerPath} failed mid-read (${scanReadError}); ` +
        `proceeding with the ${candidates.length} candidate(s) collected before the failure — ` +
        "an unreadable ledger is NOT an empty ledger",
    );
    result.errors += 1;
  }

  // WALL CLOCK — measured from HERE, after both scans, not from function
  // entry. One full streamed pass over the live 1,518,834-row ledger costs
  // ~7.6 s, so the two scans above burn ~15.1 s of wall time before any
  // extraction happens. Budgeting MAX_WALL_MS (30 s) from function entry
  // would leave under 15 s for the extractor loop today and would shrink to
  // zero as the ledger grows, turning runBackfill into a permanent no-op
  // that silently stops backfilling. The scans are already bounded by their
  // own streaming design; this budget governs only the extraction work.
  const extractWallStart = Date.now();
  for (const { factId, factRow } of candidates) {
    if (Date.now() - extractWallStart > BACKFILL_CAPS.MAX_WALL_MS) break;
    // Re-read from the map rather than using the scan-time snapshot so the
    // in-run double-emit guard below (latestBackfillByFactId.set after a
    // successful append) is observed by later candidates.
    const existing = latestBackfillByFactId.get(factId) || null;
    let extractorResult;
    try {
      extractorResult = runExtractorStack(factRow);
    } catch (err) {
      try {
        console.error(
          `feature-backfill: extractor stack threw for ${factId}: ${err && err.message ? err.message : String(err)}`,
        );
      } catch {
        // ignore
      }
      result.errors += 1;
      continue;
    }
    if (extractorResult.error) {
      try {
        console.error(
          `feature-backfill: extractor refused emit for ${factId}: ${extractorResult.error}`,
        );
      } catch {
        // ignore
      }
      result.errors += 1;
      continue;
    }
    let row;
    try {
      row = buildBackfillRow({
        factRow,
        extractorResult,
        existingBackfill: existing,
      });
    } catch (err) {
      try {
        console.error(
          `feature-backfill: row build failed for ${factId}: ${err && err.message ? err.message : String(err)}`,
        );
      } catch {
        // ignore
      }
      result.errors += 1;
      continue;
    }
    if (row == null) {
      // Byte-equal overlay → idempotent no-op (spec §6.1).
      result.skipped_noop += 1;
      try {
        console.error(
          `feature-backfill: skipped no-op for fact_id ${factId} at version ${existing != null ? existing.backfill_version : 0}`,
        );
      } catch {
        // ignore
      }
      continue;
    }
    if (dryRun) {
      // Counted as "would emit" — surface as backfill_events_emitted so
      // dry-run callers can preview the cost, but DO NOT touch the ledger.
      // Pre-fix: this `continue` jumped over the counter increment below,
      // so --dry-run always reported 0 even when 50 rows would have emitted.
      // Counter must increment HERE so operators get an accurate preview.
      result.backfill_events_emitted += 1;
      continue;
    }
    try {
      appendOneRow(ledgerPath, row);
      // Update in-memory state so subsequent facts in this same run see
      // the just-emitted backfill (prevents double-emit within one run).
      latestBackfillByFactId.set(factId, row);
      result.backfill_events_emitted += 1;
    } catch (err) {
      try {
        console.error(
          `feature-backfill: ledger append failed for ${factId}: ${err && err.message ? err.message : String(err)}`,
        );
      } catch {
        // ignore
      }
      result.errors += 1;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Read helper for tests / operators — given a ledger path, return every
// feature_backfill row currently on disk. Useful for operator audit
// queries. Defensive: returns [] on any IO failure.
// ---------------------------------------------------------------------------

export function readBackfillEventsFromLedger(ledgerPath) {
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) return [];
  const out = [];
  // Single streamed pass; retention is bounded by the number of
  // feature_backfill policy rows (83 on the live 3.05 GB ledger), never by
  // the file size. Pure read helper — it performs no writes, so a partial
  // scan is safe to return; we log it and still hand back what we parsed.
  const counts = streamLedgerLines(ledgerPath, (row) => {
    if (row == null || typeof row !== "object") return;
    if (row.kind !== "policy") return;
    if (row.policy_kind !== FEATURE_BACKFILL_KIND) return;
    out.push(row);
  });
  if (counts.readError != null) {
    logError(
      `feature-backfill: backfill-event scan of ${ledgerPath} failed (${counts.readError}); ` +
        `returning the ${out.length} row(s) parsed before the failure — ` +
        "an unreadable ledger is NOT an empty ledger",
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// TEST-ONLY EXPORTS — surfaced for substrate unit testing without invoking
// the full runBackfill path. Not part of the public behavior contract.
// ---------------------------------------------------------------------------

export const __internal = Object.freeze({
  loadLatestBackfillMap,
  collectBackfillCandidates,
  streamLedgerState,
  runExtractorStack,
  needsBackfill,
  buildBackfillRow,
  canonicalOverlayJson,
  generateRowId,
  EMITTER_MODULE,
  SUPPORTED_SOURCE_SCOPES,
});
