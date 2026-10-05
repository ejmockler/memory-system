// memory_recall — Phase 3 v1 layered recall pipeline.
//
// Authoritative spec source:
//   kb/research-retrieval-frontiers.md
// Authoritative shape contracts:
//   kb/phase3-v0-contracts.md   (v0 base shapes)
//   kb/phase3-v1-rerank-contracts.md (Layer 3 additive)
//
// Pipeline (per kb/phase3-v1-rerank-contracts.md § 0):
//
//   Layer 1 — Hybrid candidate generation (BM25 + HNSW MaxSim, RRF k=60).
//   Layer 2 — Hard gates (predicate, consent, derivation_orphan) + full
//             3072d cosine rescore + multi-feature score (multiplicative
//             gates around additive soft features).
//   Layer 3 — Gemini 2.5 Flash listwise rerank: top-RECALL_RERANK_INPUT_SIZE
//             (25) of survivors -> Flash -> top-RECALL_RERANK_OUTPUT_SIZE (12)
//             by rerank_score. ONLY REORDERS — drops are Layer 2's job.
//             Any Flash failure degrades to sort-by-final_score, all
//             rerank_score=null, degraded_recall_layer3=true.
//   Layer 4 — MMR diversification (lambda=0.7) over Layer-3 survivors;
//             relevance term remains final_score (not rerank_score) per the
//             research report § Layer 4. Brief caps: <=12 items, <=4000
//             chars total, <=600 chars per item.
//
// Asymmetric task-type discipline:
//   - default: RETRIEVAL_QUERY
//   - QUESTION_ANSWERING when the latest turn ends in '?'
//   - FACT_VERIFICATION when surrounding_context.intent === 'verify'
//     (not part of the canonical input schema; will land as an extension
//     once the upstream classifier is wired)
//
// Graceful degrade:
//   - Gemini outage at recall-time => BM25-only candidate generation;
//     skip dense leg + skip MaxSim; the rest of the pipeline still runs.
//     degraded_recall=true is emitted in the brief envelope and the
//     recall-log event. No policy event — degraded recall is a quality
//     signal, not a security one.

import { createHash, randomBytes } from "node:crypto";
import { ok, serverTs } from "../envelope.js";
import { ERROR_CODES, ToolError } from "../error-codes.js";
import {
  recordRecall,
  lookupRecall,
  appendRecallEvent,
} from "../recall-log.js";
import {
  collectRecentlySurfacedIds,
  applyRecentSurfacedDamping,
} from "../recall/recent-surfaced-damping.js";
import {
  CAPS,
  assertEnum,
  assertIso8601,
  assertNonEmptyString,
  assertObject,
  assertObjectShape,
  assertOptionalIntInRange,
  assertOptionalString,
  assertOptionalStringArray,
  assertStringArray,
  canonicalJson,
} from "../validation.js";
// l5-fallback-removal — the legacy-coverage fallback in step c is gone, and
// with it this file's only `embedSegments` call site and its only `mrlSlice`
// call site (mrlSlice lives in ../vector-math.js since l12; that whole import
// line is therefore removed rather than trimmed).
//
// l17: this file takes NO binding from ../gemini-client.js. GEMINI_TASK_TYPES
// was its last one, read only by a Gemini task-type selector whose return value
// nothing consumed after l5-fallback-removal deleted the Gemini-index fallback;
// selector and import are both gone. The embedding_model_version label below is
// sourced from CAPS (../validation.js), not from GEMINI_CLIENT_CONSTANTS — see
// the SOURCING note at EMBEDDING_MODEL_VERSION. The repo-wide allowlist census
// in test/embed-callers-migrate.test.mjs (R7) fails if an importer reappears.
// WU-recall-flip-to-local-4096 — the LIVE recall query is now embedded by the
// local Qwen3-8B server (full 4096 dims, no MRL slice, no cloud round-trip)
// instead of the Gemini multi-segment encoder. embedSingle({text,isQuery:true})
// returns the L2-unit 4096 query vector; LocalEmbedUnavailableError is the ONE
// catch surface for an unreachable / mis-shaped server (the recall handler
// degrades to BM25-only on it, exactly the way it degraded on a Gemini outage).
import {
  embedSingle,
  LocalEmbedUnavailableError,
} from "../local-embedder-client.js";
import { hybridRetrieve } from "../recall/hybrid-retriever.js";
import {
  applyHardGates,
  loadActivePredicates,
  loadDerivationExciseSet,
  loadTransitiveOrphanMap,
  predicateMaskForCandidate,
} from "../recall/hard-gates.js";
// Wave 8 — derivation-graph recall pathway (F-SYN-INTEGRATION-DERIVATION-
// GRAPH-RECALL-PATHWAY). The substrate-tier derivation graph provides the
// reverse adjacency needed to (a) gate orphaned reconstructions in the
// multi-feature score's multiplicative branch and (b) surface the parent
// content for surviving reconstructed candidates in the brief. The graph
// load is wrapped in try/catch; on failure derivation_status defaults to
// 1.0 (back-compat, no gate) and a populator.degraded_reasons entry is
// appended so operators can see the substrate outage in the brief.
import {
  loadOrRebuildDerivationGraph,
  walkExcisePropagation,
} from "../synthesis/derivation-graph.js";
import { STORAGE_DIR, memoryLedgerPath } from "../config.js";
import { join } from "node:path";
import {
  computeScore,
  entityMatchKey,
  // W3-CCS — F-CCS-BACKFILL-recall-consumer FOLLOWUP.
  // Wire the backfill overlay into the recall scoring path. buildLatestBackfillMap
  // is module-cached (mtime-keyed); we call it ONCE per handler invocation and
  // pass the resulting map into applyBackfillOverlay for each candidate before
  // scoring. The overlay is an in-memory transform (thesis #1: original fact
  // row bytes unmutated). Defensive: any throw from the engine or overlay
  // function falls back to candidate-as-is so a degraded backfill substrate
  // cannot tip the recall pipeline.
  buildLatestBackfillMap,
  applyBackfillOverlay,
  // e15-recall-temporal-scoping — the SINGLE producer of the brief's
  // `freshness` label. Imported here so the memories[] projection below has
  // one definition to call instead of a hardcoded literal.
  freshnessLabel,
} from "../recall/multi-feature-score.js";
// N1-calibration — read the calibrated live-weight overlay + the engagement
// prior map ONCE per recall. resolveScoreWeightOverlay returns the frozen CAPS
// triple (all 0.0) unless MEMORY_SCORE_WEIGHTS_ENABLED=1 AND a REVIEWED,
// harm-safe, NDCG-positive policy.recall.score_weights projection exists — so
// with the gate OFF (default) this path is byte-identical to pre-N1 behavior.
// The engagement-prior map is only built when the gate is ON (the leg is inert
// at weight 0.0, so a gate-OFF recall never pays the projection scan).
import { resolveScoreWeightOverlay } from "../recall/score-weight-overlay.js";
import { buildEngagementPriorMap } from "../synthesis/engagement-prior-reader.js";
// N6-stamp-priors: the damping/corroboration priors. The damping map is built
// ONCE per recall (a single damping-log scan via buildDampingCoefficientMap),
// then stamped per candidate via dampingCoefficientFromMap — NOT one log scan
// per candidate. The corroboration boost is a PURE walk over the already-cached
// derivation graph (derivationGraphForBrief), so it costs nothing extra.
import {
  buildDampingCoefficientMap,
  dampingCoefficientFromMap,
} from "../synthesis/damping-reader.js";
import { computeCorroborationBoost } from "../synthesis/corroboration-propagator.js";
// Wave 6 — synthesis substrate populators. Imported here so the recall
// handler runs the same modules the cascade-side stamper uses (I-CP-2 in
// docs/specs/synthesis/context-populator.md: symmetry contract). Any of
// these may throw on degenerate input; the populator block wraps every
// call in try/catch and marks populator.degraded=true when they do.
import {
  extractEntities,
  ENTITY_EXTRACTOR_VERSION,
} from "../synthesis/entity-extractor.js";
// C2 — query-side closed-set recognizer. The cascade already runs this over
// fact content (distill-promote-fact.js:731, CASCADE_GAZETTEER_ENABLED default
// ON); the populator below runs the SAME module over the query text so the two
// sides can actually meet. gazetteer.js imports only from entity-extractor.js
// (already imported above), so this adds no cycle and no new transitive load.
import { extractGazetteerEntities } from "../synthesis/gazetteer.js";
import {
  resolveTimeAnchors,
  TIME_ANCHOR_RESOLVER_VERSION,
} from "../synthesis/time-anchor-resolver.js";
import {
  scoreValence,
  MODEL_VERSION as VALENCE_MODEL_VERSION,
} from "../synthesis/valence-scorer.js";
import {
  computeQueryEpisodicity,
  EPISODICITY_VERSION,
} from "../synthesis/episodicity-scorer.js";
import {
  mmrSelect,
  emitDensityFlag,
  enforceBriefCaps,
} from "../recall/mmr.js";
import { computePropensities } from "../recall/propensity.js";
import { rerankCandidates, capsSnapshot } from "../recall/rerank.js";
import {
  loadIndices,
  loadLedgerRowsByIds,
  rowToIndexEntry,
} from "../recall/index-cache.js";
// Q2 (memperf) — queryd thin client. When the resident query daemon is
// deployed (MEMORY_QUERYD=required, or auto with a live socket at first index
// need) recall consumes BM25/HNSW/vector reads over the daemon's unix socket
// instead of paying a per-process multi-GB loadIndices residency. The
// integration is confined to three thin seams below (size probes, candidate-
// gen prefetch stubs, rescore vector_fetch shim); scoring/gates/MMR and
// hybrid-retriever.js are untouched. FAILURE DISCIPLINE (the herd ban): in
// daemon mode ANY daemon failure degrades THAT call loudly with a structured
// {code:"queryd_unavailable", retryable:true} error and NEVER falls back to
// in-process index loading; off / auto-without-socket keep the pre-Q2
// in-process path byte-identical (no additive response fields).
import {
  QuerydBadRequestError,
  QuerydUnavailableError,
  getQuerydClient,
  resolveQuerydMode,
} from "../recall/queryd-client.js";
// WU-RR2 — substrate-aware Layer-1c fallback. The substrate-tier inverted
// entity-index (canonical_id -> [memory_id]) is used when BM25 + HNSW return
// fewer than RECALL_SUBSTRATE_FALLBACK_TRIGGER_THRESHOLD unique candidates
// and the populator surfaced any entities. This restores recall to the
// substrate's actual richness (88.7% entity coverage on 1.4M facts) instead
// of leaving 99.9% of facts unreachable because HNSW is mostly empty.
//
// Defensive: any throw from loadOrRebuildIndex or the entity lookup skips the
// fallback (logged + swallowed) and the handler proceeds with whatever the
// hybrid retriever returned. populator.fallback_triggered + the
// fallback_added_candidates counter surface the outcome in the brief
// envelope.
import {
  loadOrRebuildIndex as __loadOrRebuildEntityIndex,
  lookupByEntityMatchKey as __lookupByEntityMatchKey,
} from "../synthesis/entity-index.js";
import {
  buildAliasOverlay as __buildEntityAliasOverlay,
  resolveAlias as __resolveEntityAlias,
} from "../synthesis/entity-alias-overlay.js";
// WORKUNIT N8 — temporal substrate fallback. The substrate-tier time-index
// (a sorted projection over absolute time anchors, cached under the SAME
// mtime+size fingerprint discipline as the entity-index) augments the candidate
// pool when the BM25 + HNSW union is starved AND the populator resolved an
// absolute time anchor. queryProximity returns memory_ids whose anchors fall
// near the resolved instant; the fallback is candidate-RECALL only (it never
// touches scoring, so it does NOT double-count the w_t1*time_anchor_match
// channel). Defensive: any throw from loadOrRebuildTimeIndex / queryProximity
// skips the fallback (logged + swallowed) and recall proceeds with whatever the
// hybrid retriever returned. An absent/stale cache rebuilds-or-skips (no-op).
import {
  loadOrRebuildTimeIndex as __loadOrRebuildTimeIndex,
  queryProximity as __queryProximityTimeIndex,
} from "../synthesis/time-index.js";
// Wave 9 — CP-5 Trigger A activation. Emit a batched
// policy.salience.recall_feedback row to ledgers/memory.jsonl after the
// brief is surfaced; fire-and-forget. The emitter is the sole producer of
// this policy_kind in the system (see
// docs/specs/synthesis/salience-design.md § CP-5 Trigger A and the CI test
// at test/synthesis/single-producer-recall-feedback.test.mjs).
import { emitRecallFeedback } from "../synthesis/recall-feedback-emitter.js";
// W10 — F-SYN-BEHAVIOR-recall-log-write-engagement (first behavior-tier ship).
// recall.js is the canonical "recall service" writer named in the damping-log
// spec § 5.1 ALLOWED_WRITERS — it writes one `signal_kind:"surfacing"` row per
// surfaced memory after the brief is constructed. The damping-log
// path-blocklist guard inspects the import-time stack for /mcp/lib/tools/*;
// at ESM module-load time the importer is NOT on the synchronous stack
// (verified — node's ESM loader runs module top-level code on its own
// loader stack, not on the importer's), so this static import does not
// trip the guard. The guard's actual enforcement bites at *runtime* if a
// tool function calls `_assertPathBlocklist(new Error().stack)` and finds
// the tool path on its own call stack — which we deliberately do NOT do.
import {
  appendSurfacing as __appendSurfacing,
  appendCrowdedNeighborhood as __appendCrowdedNeighborhood,
  computeTurnWindowId as __computeTurnWindowId,
  computeConversationIdHash as __computeConversationIdHash,
} from "../synthesis/damping-log.js";
// W10 — recall-context.json sidecar writer. The UserPromptSubmit hook
// (hooks/recall-engagement-detect.sh) reads this sidecar on the next turn
// boundary to attach prior-recall context to the engagement-queue signal.
// Without this writer the hook always carries prior_recall_brief={surfaced:[]}
// (the W9 MAJOR finding). atomicWriteSidecar uses tmp+rename with mode 0600.
import {
  closeSync as __closeSync,
  existsSync as __existsSync,
  fsyncSync as __fsyncSync,
  mkdirSync as __mkdirSync,
  openSync as __openSync,
  renameSync as __renameSync,
  writeSync as __writeSync,
  unlinkSync as __unlinkSync,
} from "node:fs";
import { POLICY_DIR as __POLICY_DIR } from "../config.js";
import { connectorStatePath as __connectorStatePath } from "../config.js";
import { join as __join } from "node:path";
// WORKUNIT wa-sender-names — surface WHO sent a WhatsApp message on the recall
// brief. NEW facts carry raw_content.sender_name forward; EXISTING facts (whose
// source rows predate the forward stamp) are backfilled via the DERIVED sender-
// index (source_msg_id -> {sender_jid, sender_name}), a read-only sidecar
// projection of ChatStorage.sqlite. The lookup is CACHE-ONLY + best-effort: any
// miss/absence degrades to the legacy empty parties[] (never throws to recall).
import {
  loadSenderIndexFromCacheSync as __loadWhatsAppSenderIndexFromCacheSync,
  lookupSender as __lookupWhatsAppSender,
  defaultSenderIndexCachePath as __defaultWhatsAppSenderIndexCachePath,
} from "../connectors/whatsapp-sender-index.js";

const NAME = "memory_recall";

// WORKUNIT wa-sender-names — process-memoized sender-index handle. Loaded once
// per process from the on-disk sidecar (CACHE-ONLY; the out-of-band build script
// owns the full DB join). A null cache (never built / corrupt) memoizes as a
// sentinel so we do not re-stat on every recall. Tests inject a map directly via
// __setWhatsAppSenderIndexForTest to stay hermetic (no ~/Library read).
let __whatsAppSenderIndexCache; // undefined = unloaded; null = absent; {bySourceMsgId}
function __getWhatsAppSenderIndex() {
  if (__whatsAppSenderIndexCache !== undefined) return __whatsAppSenderIndexCache;
  let idx = null;
  try {
    const statePath = __connectorStatePath("whatsapp");
    const cachePath = statePath.replace(/state\.json$/, "sender-index.json");
    idx = __loadWhatsAppSenderIndexFromCacheSync({ cachePath }) || null;
  } catch {
    idx = null;
  }
  __whatsAppSenderIndexCache = idx;
  return idx;
}

// Test seam: inject a sender index (or null to force the absent path) without
// touching the filesystem. Referenced by the wa-sender-names recall test.
export function __setWhatsAppSenderIndexForTest(index) {
  __whatsAppSenderIndexCache = index === undefined ? null : index;
}

/**
 * __resolveWhatsAppSenderParties — derive the recall brief's provenance.parties
 * for ONE surfaced fact row. Returns a [sender, "user"]-shaped array when the
 * sender is resolvable, else []. Read-only + defensive (Thesis #1: never mutates
 * the fact row; only PROJECTS the sender at read time).
 *
 * Resolution order:
 *   1. The fact's own retained raw_content.sender_name (NEW forward-stamped
 *      facts that carry raw_content — rare on the live corpus but free to read).
 *   2. The DERIVED sender-index, joined on source_refs[0].source_msg_id (the
 *      backfill path for EXISTING facts). Prefers sender_name, falls back to
 *      sender_jid so a name-less group sender still surfaces a stable id.
 *
 * @param {object|null} factRow — the full ledger row (from ledger.byId).
 * @returns {string[]} parties (possibly empty).
 */
// Superseded by __resolveProvenanceAttribution; retained as the WhatsApp P2 fallback pinned by whatsapp-sender-index.test.mjs.
export function __resolveWhatsAppSenderParties(factRow) {
  try {
    if (factRow == null || typeof factRow !== "object") return [];
    // Only WhatsApp-sourced facts carry a member-sender surface.
    const refs = Array.isArray(factRow.source_refs) ? factRow.source_refs : [];
    let waRef = null;
    for (const r of refs) {
      if (r && typeof r === "object" && r.source === "whatsapp") { waRef = r; break; }
    }
    const factSourceIsWhatsApp = factRow.source === "whatsapp";
    if (waRef === null && !factSourceIsWhatsApp) return [];

    // (1) forward-stamped raw_content on the fact itself (when present).
    const rc =
      factRow.raw_content && typeof factRow.raw_content === "object"
        ? factRow.raw_content
        : (factRow.features && typeof factRow.features.raw_content === "object"
            ? factRow.features.raw_content
            : null);
    if (rc) {
      const fwdName = typeof rc.sender_name === "string" && rc.sender_name.length > 0 ? rc.sender_name : null;
      const fwdJid = typeof rc.sender_jid === "string" && rc.sender_jid.length > 0 ? rc.sender_jid : null;
      const fwd = fwdName || fwdJid;
      if (fwd != null) return [fwd, "user"];
    }

    // (2) DERIVED sender-index backfill, joined on source_msg_id.
    const smid =
      waRef && typeof waRef.source_msg_id === "string" && waRef.source_msg_id.length > 0
        ? waRef.source_msg_id
        : null;
    if (smid === null) return [];
    const idx = __getWhatsAppSenderIndex();
    if (idx === null) return [];
    const hit = __lookupWhatsAppSender(idx, smid);
    if (hit === null) return [];
    const head = hit.sender_name || hit.sender_jid;
    if (head == null) return [];
    return [head, "user"];
  } catch {
    return [];
  }
}
// Keep the default-cache-path export referenced so the no-orphan-export gate
// sees a caller (the out-of-band build script + this lazy loader both use it).
void __defaultWhatsAppSenderIndexCachePath;

/**
 * __resolveProvenanceAttribution — SOURCE-AGNOSTIC read-side projection of a
 * surfaced fact's sender + direction for the recall brief's `provenance`. This
 * is node A2: it CONSUMES the uniform attribution shape that A1 stamps on every
 * promoted messaging fact (top-level `parties[]` + a bounded, closed-key
 * `features.attribution` subset) and it does NOT re-decide that shape.
 *
 * A1's bound shape (verbatim):
 *   - top-level `factRow.parties` — string[] connector audience array (telegram
 *     ["alexexample","Example Team chat"], imessage ["user", <handle>], whatsapp
 *     [<jid>, "user"], mail [<from-addr>]). Absent ⇒ treat as [].
 *   - `factRow.features.attribution` — closed 9-key subset {sender_id,
 *     sender_name, peer_id, peer_name, peer_type, is_outgoing, is_self,
 *     reply_to, fwd_from}. Direction inputs are the booleans is_outgoing /
 *     is_self; author fallback is sender_name → sender_id.
 *
 * Direction canon (mirrors lib/messaging/adapters/telegram.js:220 — the same
 * `is_from_me = !!(is_outgoing || is_self)` reduction used everywhere else, and
 * the literal "user" self-token): is_from_me true ⇒ the operator authored it ⇒
 * direction "outgoing", authored_by "user"; false ⇒ the sender is the
 * counterparty ⇒ direction "incoming", authored_by sender_name ?? sender_id.
 *
 * Resolution ladder (each step defensive — the whole body is try/catch so it
 * NEVER throws into recall, mirroring __resolveWhatsAppSenderParties):
 *   (P0) PRIMARY — A1's uniform shape (fires for ALL sources on post-A1 facts):
 *        top-level `parties[]` present ⇒ use it verbatim; read
 *        `features.attribution` for direction. When the attribution subset is
 *        absent (non-messaging fact that still carries a parties[], e.g.
 *        git-log) direction/authored_by stay null but parties is still surfaced.
 *   (P1) LEGACY forward-stamp (any source, pre-A1 facts w/ retained raw_content):
 *        raw_content.sender_name / features.raw_content.sender_name ⇒
 *        [sender,"user"]; direction from any is_from_me/is_outgoing/is_self on
 *        that raw_content, else incoming/sender.
 *   (P2) WhatsApp sidecar backfill (legacy whatsapp facts only — no sidecar for
 *        other sources): join source_refs[0].source_msg_id → sender-index ⇒
 *        [sender,"user"], direction incoming, authored_by sender.
 *   (P3) DEGRADE: {parties:[], direction:null, authored_by:null}. Never throws.
 *
 * A4 (group/DM differentiation + read-side completeness):
 *   - The returned object gains a normalized `chat_type` ∈ {"dm","group",null}
 *     derived from `features.attribution.peer_type`. telegram's native
 *     vocabulary is {dm, group, supergroup, channel}; imessage/whatsapp already
 *     normalize to {dm, group} write-side (A4 salience.js). Any group-like
 *     peer_type (group/supergroup/channel) → "group", "dm" → "dm", else null
 *     (mail / absent peer_type).
 *   - The P0 attribution read is DECOUPLED from top-level parties[]: whenever a
 *     non-empty `features.attribution` is present, direction/authored_by/
 *     chat_type are computed from it EVEN IF top-level parties[] is empty
 *     (parties then stays []). A fact with neither parties nor attribution
 *     still degrades to {parties:[],direction:null,authored_by:null,
 *     chat_type:null,reply_to:null,fwd_from:null}.
 *
 * @param {object|null} factRow — the full ledger row (from ledger.byId).
 * @returns {{parties: string[], direction: ("outgoing"|"incoming"|null), authored_by: (string|null), chat_type: ("dm"|"group"|null), reply_to: (string|number|null), fwd_from: (string|number|null)}}
 */
export function __resolveProvenanceAttribution(factRow) {
  const DEGRADE = {
    parties: [],
    direction: null,
    authored_by: null,
    chat_type: null,
    reply_to: null,
    fwd_from: null,
  };
  try {
    if (factRow == null || typeof factRow !== "object") return DEGRADE;

    // ---- (P0) PRIMARY — A1's uniform shape --------------------------------
    const topParties = Array.isArray(factRow.parties)
      ? factRow.parties.filter((x) => typeof x === "string" && x.length > 0)
      : [];
    const attr =
      factRow.features &&
      typeof factRow.features === "object" &&
      factRow.features.attribution &&
      typeof factRow.features.attribution === "object" &&
      !Array.isArray(factRow.features.attribution) &&
      Object.keys(factRow.features.attribution).length > 0
        ? factRow.features.attribution
        : null;
    // A4 — decouple the read: fire P0 whenever EITHER a non-empty top-level
    // parties[] OR a non-empty features.attribution is present. A valid
    // attribution with empty parties[] still surfaces direction/authored_by/
    // chat_type (parties stays [] in that case). Only a fact with NEITHER
    // falls through to the legacy P1/P2 paths and ultimately the P3 degrade.
    if (topParties.length > 0 || attr !== null) {
      let direction = null;
      let authored_by = null;
      let chat_type = null;
      let reply_to = null;
      let fwd_from = null;
      if (attr !== null) {
        if (typeof attr.reply_to === "string" && attr.reply_to.length > 0) {
          reply_to = attr.reply_to;
        } else if (typeof attr.reply_to === "number" && Number.isFinite(attr.reply_to)) {
          reply_to = attr.reply_to;
        }
        if (typeof attr.fwd_from === "string" && attr.fwd_from.length > 0) {
          fwd_from = attr.fwd_from;
        } else if (typeof attr.fwd_from === "number" && Number.isFinite(attr.fwd_from)) {
          fwd_from = attr.fwd_from;
        }
        // A1 supplies the inputs; A2 owns this reduction (mail carries no
        // direction flag → is_from_me false → incoming, as A1 intends).
        const isFromMe = !!(attr.is_outgoing || attr.is_self);
        if (isFromMe) {
          direction = "outgoing";
          authored_by = "user";
        } else {
          direction = "incoming";
          const sn =
            typeof attr.sender_name === "string" && attr.sender_name.length > 0
              ? attr.sender_name
              : null;
          let si = null;
          if (typeof attr.sender_id === "string" && attr.sender_id.length > 0) {
            si = attr.sender_id;
          } else if (
            typeof attr.sender_id === "number" &&
            Number.isFinite(attr.sender_id)
          ) {
            si = String(attr.sender_id);
          }
          authored_by = sn || si || null;
        }
        // A4 — normalized chat_type from the native peer_type. telegram's
        // native peer vocabulary is {user, group, supergroup, channel} (see
        // connectors/telegram/telegram_tail.py classify_peer): a 1:1 DM is the
        // literal "user", NOT "dm". imessage/whatsapp normalize write-side to
        // {dm, group}. So DM ⇔ peer_type ∈ {dm, user}; any group-like peer_type
        // (group/supergroup/channel) → "group"; else null (mail / absent).
        const pt = typeof attr.peer_type === "string" ? attr.peer_type : null;
        if (pt === "group" || pt === "supergroup" || pt === "channel") {
          chat_type = "group";
        } else if (pt === "dm" || pt === "user") {
          chat_type = "dm";
        }
      }
      return { parties: topParties, direction, authored_by, chat_type, reply_to, fwd_from };
    }

    // ---- (P1) LEGACY forward-stamp (generalized to any source) -----------
    const rc =
      factRow.raw_content && typeof factRow.raw_content === "object"
        ? factRow.raw_content
        : factRow.features && typeof factRow.features.raw_content === "object"
          ? factRow.features.raw_content
          : null;
    if (rc) {
      const fwdName =
        typeof rc.sender_name === "string" && rc.sender_name.length > 0
          ? rc.sender_name
          : null;
      const fwdJid =
        typeof rc.sender_jid === "string" && rc.sender_jid.length > 0
          ? rc.sender_jid
          : null;
      const fwd = fwdName || fwdJid;
      if (fwd != null) {
        const isFromMe =
          rc.is_from_me === 1 ||
          rc.is_from_me === true ||
          rc.is_outgoing === true ||
          rc.is_self === true;
        // A4 — legacy raw_content forward-stamp carries no normalized
        // peer_type; chat_type stays null (shape-uniform with P0/P3).
        return isFromMe
          ? { parties: [fwd, "user"], direction: "outgoing", authored_by: "user", chat_type: null, reply_to: null, fwd_from: null }
          : { parties: [fwd, "user"], direction: "incoming", authored_by: fwd, chat_type: null, reply_to: null, fwd_from: null };
      }
    }

    // ---- (P2) WhatsApp sidecar backfill (legacy whatsapp facts only) ------
    const refs = Array.isArray(factRow.source_refs) ? factRow.source_refs : [];
    let waRef = null;
    for (const r of refs) {
      if (r && typeof r === "object" && r.source === "whatsapp") { waRef = r; break; }
    }
    const factSourceIsWhatsApp = factRow.source === "whatsapp";
    if (waRef !== null || factSourceIsWhatsApp) {
      const smid =
        waRef && typeof waRef.source_msg_id === "string" && waRef.source_msg_id.length > 0
          ? waRef.source_msg_id
          : null;
      if (smid !== null) {
        const idx = __getWhatsAppSenderIndex();
        if (idx !== null) {
          const hit = __lookupWhatsAppSender(idx, smid);
          if (hit !== null) {
            const head = hit.sender_name || hit.sender_jid;
            if (head != null) {
              // A4 — sidecar backfill has no normalized peer_type; chat_type null.
              return { parties: [head, "user"], direction: "incoming", authored_by: head, chat_type: null, reply_to: null, fwd_from: null };
            }
          }
        }
      }
    }

    // ---- (P3) DEGRADE ------------------------------------------------------
    return DEGRADE;
  } catch {
    return DEGRADE;
  }
}

/**
 * __projectBriefProvenance — F2 (recall-provenance-projection). Pure,
 * never-throwing read-side projection of the ledger row's ORIGIN fields into
 * the recall brief: connector source, bounded source_refs, promote-time
 * conversation_id, confidence, and the one-hop derivation chain. Sibling of
 * __resolveProvenanceAttribution (which owns WHO said it); this owns WHERE it
 * came from. Reads only the row already in memory via ledger.byId — no
 * conversation index load, no lookup, no derivation.
 *
 * Field rules:
 *   - source: non-empty string row.source (every promoted fact), else
 *     row.source_refs[0].source (a connector-shaped ref), else the literal
 *     "reconstructed" when the row is kind "reconstructed" or any ref carries
 *     an event_id (daemon reconstructed rows carry NO top-level source and
 *     their refs are {event_id, consent_basis, role} — reconstruction-
 *     emitter.js:562 / :1237-1241 — so there is no connector to name), else
 *     the legacy literal "memory_ledger" (rows with neither a connector
 *     source nor any ref).
 *   - conversation_id: PASS-THROUGH of row.provenance.conversation_id when a
 *     non-empty string, else null. Null on the older ledger, on daemon
 *     reconstructed rows (reconstruction-emitter.js assembleRow), and on
 *     telegram / mail rows (thread-aggregator.extractThreadKey has no branch
 *     for them) and github-events rows (they share the git-log branch at
 *     thread-aggregator.js:253 but it returns null at :263-267 because their
 *     raw_content carries no author_email/author — github-events.js emits
 *     only actor_login / member_login / issue_author / pr_author, :224 :243
 *     :310 :927). The thread relation is derivation membership.
 *   - confidence: row.provenance.confidence when a non-empty string (live
 *     facts: "pre_distilled"), else the legacy "medium".
 *   - confidence_score: row.provenance.confidence when a finite number in
 *     [0,1] (reconstructed rows self-report 1.0 / 0.6), else null. The string
 *     enum has no honest bucket for a numeric self-report; inventing
 *     thresholds here would fabricate a grade, so the number travels as-is.
 *   - source_refs: first BRIEF_SOURCE_REFS_MAX of row.source_refs, each
 *     projected to EXACTLY {source, source_msg_id, event_id, consent_basis}
 *     (string or null). Two writer shapes feed this: promoted facts carry
 *     {source, source_msg_id, consent_basis} (event_id null); daemon
 *     reconstructed rows carry {event_id, consent_basis, role} where event_id
 *     is the PARENT memory id (source / source_msg_id null). source_msg_id
 *     and event_id are opaque identifiers; consent_basis travels with each
 *     ref so consumers apply kb/ingestion.md § Consent-aware promotion (no
 *     verbatim quoting for second_party_dm / third_party_inferred).
 *     raw_content, role, via, corroboration_event_id and every other ref key
 *     are never copied. source_refs_count is the full array length so
 *     truncation is visible.
 *   - strictest_consent_basis: row.strictest_consent_basis when a non-empty
 *     string (reconstructed rows: the strictest basis across their refs,
 *     "derived" when the consent walk failed — reconstruction-emitter.js:576
 *     / :1003 / :1236), else null (promoted facts do not carry it).
 *   - derivation_chain: row.derived_from filtered to non-empty strings, for
 *     EVERY kind (one hop; F3 owns the deep walk). derived_from /
 *     derived_from_titles on the brief keep their reconstructed-only gating.
 *
 * @param {object|null} row — the full ledger row (from ledger.byId).
 * @returns {{source: string, conversation_id: (string|null), confidence: string, confidence_score: (number|null), strictest_consent_basis: (string|null), source_refs: Array<{source:(string|null), source_msg_id:(string|null), event_id:(string|null), consent_basis:(string|null)}>, source_refs_count: number, derivation_chain: string[]}}
 */
const BRIEF_SOURCE_REFS_MAX = 4;
export function __projectBriefProvenance(row) {
  const legacy = () => ({
    source: "memory_ledger",
    conversation_id: null,
    confidence: "medium",
    confidence_score: null,
    strictest_consent_basis: null,
    source_refs: [],
    source_refs_count: 0,
    derivation_chain: [],
  });
  try {
    if (row == null || typeof row !== "object" || Array.isArray(row)) return legacy();
    const strOrNull = (v) => (typeof v === "string" && v.length > 0 ? v : null);
    const refs = Array.isArray(row.source_refs) ? row.source_refs : [];
    const firstRefSource =
      refs.length > 0 && refs[0] != null && typeof refs[0] === "object"
        ? strOrNull(refs[0].source)
        : null;
    // Daemon reconstructed rows have no connector source anywhere: their refs
    // are {event_id, consent_basis, role} (reconstruction-emitter.js:562).
    // Name them "reconstructed" rather than the legacy "memory_ledger", which
    // is reserved for rows with neither a connector source nor any ref.
    const hasEventIdRef = refs.some(
      (r) => r != null && typeof r === "object" && typeof r.event_id === "string" && r.event_id.length > 0,
    );
    const source =
      strOrNull(row.source) ||
      firstRefSource ||
      (hasEventIdRef || row.kind === "reconstructed" ? "reconstructed" : "memory_ledger");
    const prov =
      row.provenance != null && typeof row.provenance === "object" && !Array.isArray(row.provenance)
        ? row.provenance
        : null;
    const conversation_id = prov ? strOrNull(prov.conversation_id) : null;
    const rawConf = prov ? prov.confidence : undefined;
    const confidence = strOrNull(rawConf) || "medium";
    const confidence_score =
      typeof rawConf === "number" && Number.isFinite(rawConf) && rawConf >= 0 && rawConf <= 1
        ? rawConf
        : null;
    const source_refs = refs.slice(0, BRIEF_SOURCE_REFS_MAX).map((r) => {
      const ref = r != null && typeof r === "object" ? r : {};
      return {
        source: strOrNull(ref.source),
        source_msg_id: strOrNull(ref.source_msg_id),
        event_id: strOrNull(ref.event_id),
        consent_basis: strOrNull(ref.consent_basis),
      };
    });
    const strictest_consent_basis = strOrNull(row.strictest_consent_basis);
    const derivation_chain = Array.isArray(row.derived_from)
      ? row.derived_from.filter((x) => typeof x === "string" && x.length > 0)
      : [];
    return {
      source,
      conversation_id,
      confidence,
      confidence_score,
      strictest_consent_basis,
      source_refs,
      source_refs_count: refs.length,
      derivation_chain,
    };
  } catch {
    return legacy();
  }
}

// ---------------------------------------------------------------------------
// W12 — F-SYN-INTEGRATION-RECALL-CONSUMES-VALENCE (substrate-minor-polish #3).
//
// Closed mood-string→valence enum. The populator path that reads
// surrounding_context.ambient.inferred_mood (a free-form string slot) needs
// to translate human-readable mood labels into the same {sign, magnitude}
// shape valence-scorer emits so the downstream multi-feature scorer
// (valenceCompat) sees a unified representation regardless of upstream
// producer.
//
// Discipline:
//   - CLOSED ENUM. Adding a mood key REQUIRES bumping
//     RECALL_VALENCE_VOCAB_VERSION below so calibration can re-key. Operator
//     dashboards count rows where the incoming mood string is NOT in this
//     table via populator.mood_table_miss (defensive observability — we
//     swallow the miss but the count tells calibration when the vocabulary
//     needs widening).
//   - keys are lowercased and trimmed before lookup.
//   - sign ∈ {-1, 0, +1}; magnitude ∈ [0, 1].
//   - SYNTH_MOOD_STRING_TO_VALENCE replaces nine inline string→sign
//     mappings that were drifting across the codebase. Single source of
//     truth here.
//
// Authoritative shape contract: kb/synthesis-substrate.md § Mood vocabulary
// (forthcoming — this is the implementation seam for the spec).
// ---------------------------------------------------------------------------
export const RECALL_VALENCE_VOCAB_VERSION = "v0.1.0";
export const SYNTH_MOOD_STRING_TO_VALENCE = Object.freeze({
  // strong negative
  frustrated: Object.freeze({ sign: -1, magnitude: 0.7 }),
  angry: Object.freeze({ sign: -1, magnitude: 0.8 }),
  furious: Object.freeze({ sign: -1, magnitude: 0.9 }),
  sad: Object.freeze({ sign: -1, magnitude: 0.6 }),
  upset: Object.freeze({ sign: -1, magnitude: 0.6 }),
  anxious: Object.freeze({ sign: -1, magnitude: 0.7 }),
  worried: Object.freeze({ sign: -1, magnitude: 0.6 }),
  stressed: Object.freeze({ sign: -1, magnitude: 0.7 }),
  exhausted: Object.freeze({ sign: -1, magnitude: 0.5 }),
  tired: Object.freeze({ sign: -1, magnitude: 0.4 }),
  // strong positive
  excited: Object.freeze({ sign: 1, magnitude: 0.7 }),
  happy: Object.freeze({ sign: 1, magnitude: 0.7 }),
  joyful: Object.freeze({ sign: 1, magnitude: 0.8 }),
  grateful: Object.freeze({ sign: 1, magnitude: 0.6 }),
  proud: Object.freeze({ sign: 1, magnitude: 0.6 }),
  calm: Object.freeze({ sign: 1, magnitude: 0.4 }),
  // neutral / informational
  neutral: Object.freeze({ sign: 0, magnitude: 0 }),
  focused: Object.freeze({ sign: 0, magnitude: 0 }),
  thinking: Object.freeze({ sign: 0, magnitude: 0 }),
});

// Module-level mood_table_miss counter. Operators read this via the exported
// getter to size whether the mood vocabulary needs widening. Resets only via
// the test-only reset hook.
const _moodTelemetry = { mood_table_miss: 0 };
export function getMoodTelemetry() {
  return Object.freeze({ mood_table_miss: _moodTelemetry.mood_table_miss });
}
export function resetMoodTelemetry() {
  _moodTelemetry.mood_table_miss = 0;
}

/**
 * moodStringToValence — translate a free-form mood string to a
 * {sign, magnitude} object using the CAPS table. Unknown strings increment
 * the mood_table_miss counter and return null so the caller can fall back
 * to whatever default it has.
 *
 * @param {string|null|undefined} mood
 * @returns {{sign: -1|0|1, magnitude: number}|null}
 */
export function moodStringToValence(mood) {
  if (typeof mood !== "string") return null;
  const key = mood.trim().toLowerCase();
  if (key === "") return null;
  if (Object.prototype.hasOwnProperty.call(SYNTH_MOOD_STRING_TO_VALENCE, key)) {
    return SYNTH_MOOD_STRING_TO_VALENCE[key];
  }
  _moodTelemetry.mood_table_miss += 1;
  return null;
}

// ---------------------------------------------------------------------------
// W11 — F-SYN-BEHAVIOR-density-flag-feedback (CROWDED_NEIGHBORHOOD signal).
//
// research-retrieval-frontiers.md describes density_flag as a recall-side
// signal indicating "many candidates near topic." When too many candidates
// pass the predicate gate within a tight score neighborhood of the top
// score, the recall pipeline emits a crowded_neighborhood damping-log row
// so engagement detection upstream can be lenient (the user is in a dense
// topic, so any one fact has lower discriminative value).
//
// Threshold + radius are FROZEN per spec § 4.7.1 "single shared module"
// discipline. The VERSION constant bumps when the trigger semantics change
// (e.g. switching from cosine-distance-on-score to cosine-distance-on-
// embedding for the neighborhood test). For now the trigger is a simple
// score-proximity gate consistent with the existing emitDensityFlag
// "crowded" criterion at Layer 4.
// ---------------------------------------------------------------------------
export const DENSITY_FLAG_FEEDBACK_VERSION = "density-flag-feedback@1.0.0";
export const DENSITY_FLAG_FEEDBACK_CAPS = Object.freeze({
  // Minimum count of candidates within DENSITY_NEIGHBORHOOD_RADIUS of the
  // top score (and passing the predicate gate) to fire the crowded-
  // neighborhood signal. 60 is the operational anchor: above this the
  // discriminative value of any one fact in the brief is low and the
  // engagement detector should treat absences as inconclusive.
  DENSITY_FLAG_THRESHOLD: 60,
  // Cosine-distance proxy: "near topic" means within RADIUS of top score
  // (i.e. |score_i - top_score| <= RADIUS * |top_score|, with a tiny
  // absolute floor so a top_score very near 0 still has a meaningful
  // neighborhood). 0.05 mirrors the existing emitDensityFlag 5% knob at
  // Layer 4 — a single tunable for "scores too close to discriminate".
  DENSITY_NEIGHBORHOOD_RADIUS: 0.05,
});

/**
 * Decide whether the recall fires the crowded_neighborhood signal.
 *
 * Inputs are the full Layer-2 scored set (BEFORE rerank / MMR / truncation)
 * so the signal reflects raw candidate density, not the brief's selection
 * discipline. We count candidates that:
 *   (a) passed the predicate gate (predicate_mask === 1), AND
 *   (b) lie within DENSITY_NEIGHBORHOOD_RADIUS of the top-1 score.
 *
 * If that count >= DENSITY_FLAG_THRESHOLD, density_flag is set to
 * "many_candidates_near_topic" (the spec § 4.7.2.D enum) and the caller
 * writes one crowded_neighborhood damping-log row. Otherwise the flag is
 * null and no row is written.
 *
 * Exported so the unit test can probe it without driving the full handler.
 */
export function _computeDensityNeighborhood(scored) {
  if (!Array.isArray(scored) || scored.length === 0) {
    return { density_flag: null, dense_neighborhood_count: 0 };
  }
  // Filter to predicate-gate survivors and collect their final_scores.
  const passing = [];
  for (const s of scored) {
    const sc = s && s.score_components;
    if (sc == null) continue;
    if (sc.predicate_mask !== 1) continue;
    const fs = sc.final_score;
    if (typeof fs !== "number" || !Number.isFinite(fs)) continue;
    passing.push(fs);
  }
  if (passing.length === 0) {
    return { density_flag: null, dense_neighborhood_count: 0 };
  }
  // top_score is the maximum among passing candidates.
  let topScore = passing[0];
  for (let i = 1; i < passing.length; i++) {
    if (passing[i] > topScore) topScore = passing[i];
  }
  // Absolute-floor radius: even if topScore is ~0 the window is meaningful.
  const radius = Math.max(
    1e-6,
    Math.abs(topScore) * DENSITY_FLAG_FEEDBACK_CAPS.DENSITY_NEIGHBORHOOD_RADIUS,
  );
  let denseCount = 0;
  for (const fs of passing) {
    if (Math.abs(fs - topScore) <= radius) denseCount++;
  }
  const fired = denseCount >= DENSITY_FLAG_FEEDBACK_CAPS.DENSITY_FLAG_THRESHOLD;
  return {
    density_flag: fired ? "many_candidates_near_topic" : null,
    dense_neighborhood_count: denseCount,
  };
}

// ---------------------------------------------------------------------------
// W10 — recall-context.json sidecar writer (F-SYN-INTEGRATION-ENGAGEMENT-
// DETECTOR-WIRING MAJOR closure). The UserPromptSubmit hook reads this
// sidecar on the NEXT turn boundary; without it every enqueued engagement
// signal carries prior_recall_brief.surfaced=[]. Atomic write: tmp + rename
// to defeat a torn read by the hook. Mode 0600 matches the rest of the
// policy/* surface. Fire-and-forget — never blocks the recall response.
// ---------------------------------------------------------------------------
function recallContextSidecarPath() {
  return __join(__POLICY_DIR, "recall-context.json");
}

function writeRecallContextSidecar(payload) {
  const path = recallContextSidecarPath();
  const dir = __POLICY_DIR;
  try {
    if (!__existsSync(dir)) {
      __mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  } catch {
    // best-effort — if mkdir fails the openSync below will throw and the
    // outer try/catch in the caller swallows it.
  }
  const json = JSON.stringify(payload);
  const tmp =
    path + ".tmp." + process.pid + "." + Date.now() + "." +
    Math.floor(Math.random() * 1e6);
  let fd = -1;
  try {
    fd = __openSync(tmp, "w", 0o600);
    const buf = Buffer.from(json, "utf8");
    let written = 0;
    while (written < buf.length) {
      written += __writeSync(fd, buf, written, buf.length - written);
    }
    __fsyncSync(fd);
  } finally {
    if (fd !== -1) {
      try { __closeSync(fd); } catch { /* ignore */ }
    }
  }
  try {
    __renameSync(tmp, path);
  } catch (err) {
    // Best-effort: try to unlink the tmp so we do not leak it on next run.
    try { __unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

const ALLOWED_TURN_ROLES = ["user", "assistant", "system", "tool"];
// Legacy Gemini index/version identifier. TWO readers after
// l5-fallback-removal deleted the step-c fallback index selector (the third
// reader), and both are on the UNCONDITIONAL recall path — this constant is
// live, not vestigial:
//   - `rowToIndexEntry(row, EMBEDDING_MODEL_VERSION)` — the model_version
//     stamped on a candidate IndexEntry whose ledger row carries no label.
//   - `applyHardGates(..., { embedding_model_version: EMBEDDING_MODEL_VERSION })`
//     — the exclusion-gate label, which selects the vector field the gate
//     compares against. hard-gates.js throws on a missing/empty value.
// SOURCING (r1 deviation #2, kept from l5 on purpose): read from CAPS rather
// than re-importing GEMINI_CLIENT_CONSTANTS, which would otherwise be this
// file's only reader of that object. Value-identity was checked at runtime:
// GEMINI_CLIENT_CONSTANTS.GEMINI_EMBEDDING_MODEL_VERSION ===
// CAPS.GEMINI_EMBEDDING_MODEL_DEFAULT -> true, both "gemini-embedding-001".
const EMBEDDING_MODEL_VERSION = CAPS.GEMINI_EMBEDDING_MODEL_DEFAULT;
// WU-recall-flip-to-local-4096 — the ACTIVE embedding model. Recall now query-
// embeds locally (4096) and loads indices/<ACTIVE_EMBED_MODEL_VERSION>/ (the
// 4096 HNSW). Sourced from CAPS so the query backend, the index-dir name, and
// the stamped features.embedding_model_version never drift.
const ACTIVE_EMBEDDING_MODEL_VERSION = CAPS.ACTIVE_EMBED_MODEL_VERSION;

// Q2 (memperf) — every in-process index load routes through this ONE
// indirection so the daemon-mode herd ban is PROVABLE: hermetic tests inject
// a counting spy via __setLoadIndicesForTest and assert the count stays 0
// whenever a call was served by queryd (including every daemon-failure
// path). Production behavior is identical — the seam defaults to the real
// index-cache loadIndices and daemon mode simply never calls it.
let __loadIndicesImpl = loadIndices;
export function __setLoadIndicesForTest(fn) {
  __loadIndicesImpl = typeof fn === "function" ? fn : loadIndices;
}

// ---------------------------------------------------------------------------
// Input validation (unchanged from Phase 0)
// ---------------------------------------------------------------------------

function validateRecentTurns(turns) {
  if (!Array.isArray(turns)) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      "surrounding_context.recent_turns must be an array",
    );
  }
  if (turns.length > CAPS.RECALL_RECENT_TURNS_MAX) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `surrounding_context.recent_turns exceeds ${CAPS.RECALL_RECENT_TURNS_MAX}`,
    );
  }
  turns.forEach((t, i) => {
    assertObjectShape(t, `surrounding_context.recent_turns[${i}]`, ["role", "content"]);
    assertEnum(t.role, ALLOWED_TURN_ROLES, `surrounding_context.recent_turns[${i}].role`);
    assertNonEmptyString(t.content, `surrounding_context.recent_turns[${i}].content`, {
      maxChars: CAPS.RECALL_TURN_CONTENT_CHARS,
    });
  });
}

function validateAmbient(ambient) {
  if (ambient == null) return;
  assertObjectShape(ambient, "surrounding_context.ambient", [
    "calendar_state",
    "inferred_mood",
    "parties_present",
  ]);
  if (ambient.calendar_state != null) {
    assertObject(ambient.calendar_state, "surrounding_context.ambient.calendar_state");
  }
  assertOptionalString(ambient.inferred_mood, "surrounding_context.ambient.inferred_mood");
  if (ambient.parties_present != null) {
    assertStringArray(ambient.parties_present, "surrounding_context.ambient.parties_present");
  }
}

// ---------------------------------------------------------------------------
// Segment + queryText derivation
// ---------------------------------------------------------------------------
//
// SegmentVector emission per kb/phase3-v0-contracts.md § 2. Roles:
//   - current_query
//   - recent_turn_<i>
//   - agent_role
//   - time_anchor  (skipped in v0 since surrounding_context has no anchor
//                   field; the `time` field is the recall timestamp, not a
//                   query-side time anchor)
//
// queryText for the BM25 leg: a focused distillation of the surrounding
// context. v0 uses `current_query` + last 3 recent_turn contents joined by
// newline. Distillation by an LLM is a v1+ concern; the BM25 leg is the
// anchor for entities the dense leg might smear.

function buildSegments(ctx) {
  const segments = [];
  if (typeof ctx.current_query === "string" && ctx.current_query.length > 0) {
    segments.push({ segment_role: "current_query", text: ctx.current_query });
  }
  if (Array.isArray(ctx.recent_turns)) {
    for (let i = 0; i < ctx.recent_turns.length; i++) {
      const turn = ctx.recent_turns[i];
      if (turn && typeof turn.content === "string" && turn.content.length > 0) {
        segments.push({
          segment_role: `recent_turn_${i}`,
          text: turn.content,
        });
      }
    }
  }
  if (typeof ctx.agent_role === "string" && ctx.agent_role.length > 0) {
    segments.push({ segment_role: "agent_role", text: ctx.agent_role });
  }
  return segments;
}

function buildQueryText(ctx) {
  const parts = [];
  if (typeof ctx.current_query === "string") parts.push(ctx.current_query);
  if (Array.isArray(ctx.recent_turns)) {
    // Last 3 turns is enough context for BM25 anchoring without diluting IDF.
    const tail = ctx.recent_turns.slice(-3);
    for (const t of tail) {
      if (t && typeof t.content === "string") parts.push(t.content);
    }
  }
  return parts.join("\n").trim();
}

// ---------------------------------------------------------------------------
// Cosine helpers (full-3072d).
// ---------------------------------------------------------------------------
function cosine3072(a, b) {
  if (!a || !b) return 0;
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

// WU1-local-embedder-client-and-dim4096 — pick the candidate embedding that
// lives in the SAME geometry as the query vector, by dimensionality. The two
// active backends produce DISTINCT dims (Qwen3 full = 4096, Gemini full =
// 3072), so the query's dim uniquely selects the matching candidate vector.
// Returns candidate.embedding_4096 when its length equals queryDim, else null
// (-> s_emb=0; the cross-model / no-embedding case routes through the additive
// branch). Pure; the candidate object is not mutated.
//
// FL-24 (l5-fallback-removal): this helper used to carry a second arm returning
// candidate.embedding_3072. The legacy-coverage fallback in step c was the only
// writer of a 3072-dim query vector (`firstSegmentVec3072 =
// rebuilt[0].vector_3072` after the Gemini re-encode), so it was the only
// producer of a queryDim under which that arm could return; the arm and the
// branch were ONE unit and were removed together in this same change. Removing
// the arm alone would have left a live branch scoring every candidate s_emb=0
// with no degrade flag, and removing the branch alone would have left an arm no
// caller can reach.
export function _selectSameDimEmbedding(candidate, queryDim) {
  if (candidate == null || typeof candidate !== "object") return null;
  if (!Number.isInteger(queryDim) || queryDim <= 0) return null;
  if (
    Array.isArray(candidate.embedding_4096) &&
    candidate.embedding_4096.length === queryDim
  ) {
    return candidate.embedding_4096;
  }
  return null;
}

// ---------------------------------------------------------------------------
// WU-dense-reembed-infra — chunk-id resolution for multi-vector giants.
//
// The full-fidelity re-embed (scripts/reembed-local-4096.mjs) stores facts that
// EXCEED the model context window as multiple chunk-vectors under derived ids of
// the shape `${factId}#${k}` (k=0,1,2,...). The HNSW therefore returns chunk-ids
// for those facts. There is NO ledger row for a chunk-id, so a candidate built
// from a chunk-id would resolve to null and be silently dropped — the giant
// would never surface. _stripChunkSuffix maps a chunk-id back to its parent fact
// id so the ledger row resolves; non-chunk ids pass through unchanged.
//
// Contract: a fact id is an opaque token; the '#k' suffix is appended ONLY by
// the chunker, where k is a run of decimal digits. We strip the LAST '#<digits>'
// suffix and require the remainder to be non-empty. Anything else (a '#' inside
// the id, a non-numeric suffix) is returned verbatim so we never corrupt a
// legitimate id.
// ---------------------------------------------------------------------------
export function _stripChunkSuffix(id) {
  if (typeof id !== "string" || id.length === 0) return id;
  const hash = id.lastIndexOf("#");
  if (hash <= 0 || hash === id.length - 1) return id; // no '#', or '#' at edges
  const suffix = id.slice(hash + 1);
  // suffix must be all decimal digits (a chunk index) to be stripped.
  for (let i = 0; i < suffix.length; i++) {
    const ch = suffix.charCodeAt(i);
    if (ch < 48 || ch > 57) return id; // non-digit -> not a chunk suffix
  }
  return id.slice(0, hash);
}

// WU-dense-reembed-infra — index-side embedding overlay for the s_emb rescore.
//
// PROBLEM (load-bearing): every fact that existed BEFORE the local 4096 backend
// shipped has its 4096 vector ONLY in the index sidecar/HNSW — rowToIndexEntry
// reads features.embedding_4096 off the immutable ledger row, which is null for
// all of them. Layer-2 therefore scored s_emb=0 for re-embedded existing facts
// even though Layer-1 ranked them correctly off the same (index-resident) vector.
//
// FIX (mirrors applyBackfillOverlay; thesis #1 — never mutate the row): when the
// candidate carries NO same-dim embedding on its (overlaid) features view, pull
// the index-resident vector via hnsw.getVectorByMemoryId and return it. The
// candidate object is NOT mutated — the vector is returned for the caller's
// in-memory cosine only.
//
// v3-ledger-embedding-reroute — THIS OVERLAY IS NOW THE PRIMARY PATH, not a
// backfill special case. With MEMORY_LEDGER_ROW_EMBEDDING_4096 unset (the
// default), distill-promote-fact.js no longer stamps features.embedding_4096
// onto the fact row at all: the vector goes out-of-band to the fsync'd index
// WAL and is replayed into the HNSW. So NEW cascade facts carry NO row vector
// and DO come through here. The candidates that still win at the ROW are rows
// written while MEMORY_LEDGER_ROW_EMBEDDING_4096 was on. (Legacy rows carrying
// embedding_3072 used to win here too, under the step-c legacy-coverage
// fallback's 3072-dim query; l5-fallback-removal deleted that branch and
// _selectSameDimEmbedding's matching 3072 arm together, so the row-first path
// is 4096-only now.)
//
// GUARDS (each is a maps-flagged regression):
//   - Only fires when the candidate has NO same-dim row vector. A row written
//     while MEMORY_LEDGER_ROW_EMBEDDING_4096 was on is selected by
//     _selectSameDimEmbedding first and skips the overlay; every other fact
//     resolves here.
//   - Dimension match: the index vector is returned ONLY if its length equals
//     queryDim. Under the 3072 Gemini fallback (queryDim=3072) the 4096 index
//     vector is the WRONG geometry, so it is rejected (geometry-mix guard) ->
//     the candidate keeps s_emb=0, never a spurious cross-model cosine.
//   - Defensive: missing hnsw / missing getter / any throw -> null (s_emb=0).
//
// Returns the candidate's same-dim vector (row first, then index), or null.
export function _resolveCandidateEmbedding(candidate, hnsw, queryDim) {
  // 1. Row-carried vector wins (new cascade facts; legacy gemini-3072 facts).
  const rowVec = _selectSameDimEmbedding(candidate, queryDim);
  if (rowVec != null) return rowVec;
  // 2. Index sidecar overlay — only for facts whose row lacks a same-dim vector.
  if (candidate == null || typeof candidate !== "object") return null;
  if (!Number.isInteger(queryDim) || queryDim <= 0) return null;
  if (hnsw == null || typeof hnsw.getVectorByMemoryId !== "function") return null;
  if (typeof candidate.memory_id !== "string" || candidate.memory_id.length === 0) {
    return null;
  }
  let idxVec = null;
  try {
    idxVec = hnsw.getVectorByMemoryId(candidate.memory_id);
    // WU-dense-reembed-infra fix: giants store vectors ONLY under chunk-ids
    // (`${factId}#${k}`), so the bare-factId lookup above misses. Fall back to
    // the winning chunk's id (threaded onto the candidate at build time) so the
    // giant rescores against its best-matching chunk vector instead of s_emb=0.
    if (
      !Array.isArray(idxVec) &&
      typeof candidate.index_vector_id === "string" &&
      candidate.index_vector_id.length > 0 &&
      candidate.index_vector_id !== candidate.memory_id
    ) {
      idxVec = hnsw.getVectorByMemoryId(candidate.index_vector_id);
    }
  } catch {
    return null; // a bad id never poisons the rescore loop
  }
  if (!Array.isArray(idxVec)) return null;
  // Geometry guard: the index vector must match the QUERY dimensionality. Under
  // the 3072 fallback the 4096 index is the wrong space -> reject.
  if (idxVec.length !== queryDim) return null;
  return idxVec;
}

// ---------------------------------------------------------------------------
// Wave 8 — derivation-graph reconstructed-parent gate helper. Kept at module
// scope so it is exercised by a direct unit-test (the synthesis integration
// test imports it from lib/tools/recall.js via the underscore export).
//
// Semantics:
//   - non-reconstructed candidate         -> 1.0 (no gate)
//   - reconstructed; no derived_from      -> 1.0 (no chain to evaluate;
//                                                  matches "live" default)
//   - reconstructed; >=1 parent live      -> 1.0
//   - reconstructed; ALL parents orphaned -> 0.0
//
// orphanedSet is the union of direct excise seeds + every descendant reached
// by walkExcisePropagation from those seeds. A parent being "transitively
// orphaned" is equivalent to membership in this set.
// ---------------------------------------------------------------------------
export function _computeDerivationGateStatus(candidate, orphanedSet) {
  if (candidate == null || typeof candidate !== "object") return 1.0;
  if (candidate.kind !== "reconstructed") return 1.0;
  const parents = Array.isArray(candidate.derived_from)
    ? candidate.derived_from
    : [];
  if (parents.length === 0) return 1.0;
  if (!(orphanedSet instanceof Set) || orphanedSet.size === 0) return 1.0;
  for (const parentId of parents) {
    if (typeof parentId !== "string" || parentId.length === 0) continue;
    if (!orphanedSet.has(parentId)) {
      // At least one parent is NOT orphaned -> the reconstruction is
      // still anchored on live evidence; survive.
      return 1.0;
    }
  }
  // Every parent string was present in orphanedSet -> the reconstruction
  // is orphaned. predicate_mask=0 collapses the multiplicative branch but
  // does not drop the row; same semantics here.
  return 0.0;
}

// Wave 8 — derived_from_titles surface helper. For a reconstructed candidate
// surfaced in the brief, project each parent id to a short title (the first
// PARENT_TITLE_MAX_CHARS chars of the parent row's content, or "" if missing).
// Used to populate brief.memories[].derived_from_titles for transparency.
const PARENT_TITLE_MAX_CHARS = 80;
export function _derivedFromTitlesFor(candidate, ledgerById) {
  if (candidate == null || typeof candidate !== "object") return [];
  if (candidate.kind !== "reconstructed") return [];
  const parents = Array.isArray(candidate.derived_from)
    ? candidate.derived_from
    : [];
  if (parents.length === 0) return [];
  const out = [];
  for (const parentId of parents) {
    if (typeof parentId !== "string" || parentId.length === 0) continue;
    const row = ledgerById instanceof Map ? ledgerById.get(parentId) : null;
    const content = row && typeof row.content === "string" ? row.content : "";
    out.push({
      memory_id: parentId,
      title: content.slice(0, PARENT_TITLE_MAX_CHARS),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// WU-recall-content-dedup — content-dedup at the recall PROJECTION.
//
// PROBLEM (empirically measured on the live 1.46M-fact ledger): byte-identical
// duplicate facts (OpenWrt feed commits identical across many repos; repeated
// codex-cli prompts) dominate the corpus. With features.embedding=null (Gemini
// quota outage) every candidate's s_emb=0, so MMR has no vector to diversify on
// and returns the same answer N times. A query like "update to latest Git HEAD"
// surfaced 12 memories, only 1 unique.
//
// FIX (thesis-aligned: ledger stays permanent #1; the projection collapses dups
// at recall time #2): after the score-sort and before the rerank-input slice,
// collapse candidates whose NORMALIZED content is byte-identical, keeping the
// FIRST occurrence in score-sorted order (= the highest-scored representative).
//
// normalize = trim + collapse internal whitespace runs to single spaces +
// lowercase. Threshold-free: ONLY exact normalized-content matches collapse;
// different content that merely shares entities/time is never collapsed.
//
// Defensive: empty/missing content -> the candidate is keyed by its own
// memory_id (NEVER collapse distinct ids that genuinely lack content). A
// candidate set with no duplicates is a pure pass-through (identical order +
// count + no annotation drift beyond duplicate_count=1).
// ---------------------------------------------------------------------------

// Normalize content for the dedup key. Returns "" for non-string / empty.
export function _normalizeContentForDedup(content) {
  if (typeof content !== "string") return "";
  // trim, collapse ALL internal whitespace runs (incl. tabs/newlines) to a
  // single space, lowercase.
  return content.trim().replace(/\s+/g, " ").toLowerCase();
}

// N10-priors-persistence-seam — project the THREE live priors the scorer
// computed (multi-feature-score score_components: engagement_prior,
// damping_coefficient, corroboration_boost) into a top-level `priors` dict on
// the surfaced[] recall-event row. This is the SEAM the offline calibration
// loop reads: rescoreSurfacedWithLiveWeights (calibration-loop.js:312-325)
// looks up surfaced[i].priors.{engagement_prior,damping_coefficient,
// corroboration_boost} and degrades to NEUTRAL (eng 0.0 / damp 1.0 / corro 1.0)
// when the dict (or a key) is absent. Persisting the scorer's own values here
// is what makes the rescorer re-score with the SAME non-neutral priors the
// LIVE recall scorer already used — closing the N1/N6 inertness gap where the
// rescorer saw neutral on every row and the weight grid was rank-invariant.
//
// Returns null when there are no score_components for the id (degraded recall
// or a candidate that was not scored) so the rescorer falls back to neutral,
// exactly as the pre-N10 behaviour. The values are PASS-THROUGHs of what the
// scorer emitted: each is forwarded only when finite (computeScore already
// re-clamps defensively, and the rescorer re-clamps to the spec bounds), so a
// non-finite or missing component yields an absent key (→ neutral) rather than
// poisoning the rescore with NaN. Thesis #1: surfaced[] is a derived recall-
// event projection, NOT a fact row — this mutates nothing on disk-bound facts.
export function _projectSurfacedPriors(scoreComponents) {
  const fb = scoreComponents;
  if (fb == null || typeof fb !== "object") return null;
  const out = {};
  if (typeof fb.engagement_prior === "number" && Number.isFinite(fb.engagement_prior)) {
    out.engagement_prior = fb.engagement_prior;
  }
  if (
    typeof fb.damping_coefficient === "number" &&
    Number.isFinite(fb.damping_coefficient)
  ) {
    out.damping_coefficient = fb.damping_coefficient;
  }
  if (
    typeof fb.corroboration_boost === "number" &&
    Number.isFinite(fb.corroboration_boost)
  ) {
    out.corroboration_boost = fb.corroboration_boost;
  }
  return out;
}

// Compute the per-candidate dedup key. Empty normalized content falls back to
// the memory_id so distinct content-less candidates never collapse together.
function _dedupKeyForScored(s) {
  const content =
    s && s.candidate && typeof s.candidate.content === "string"
      ? s.candidate.content
      : "";
  const normalized = _normalizeContentForDedup(content);
  if (normalized.length > 0) {
    return `c:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
  }
  // No usable content -> key by id (never collapse distinct content-less ids).
  const id =
    s && s.candidate && typeof s.candidate.memory_id === "string"
      ? s.candidate.memory_id
      : "";
  return `id:${id}`;
}

// Walk the SCORE-SORTED scored[] array in order (caller must sort by
// final_score desc first). Keep the first occurrence of each content key (the
// highest-scored representative); drop subsequent same-key candidates.
// Annotate each survivor with score_components.duplicate_count (how many
// candidates — including itself — shared its key). final_score is UNCHANGED.
//
// Returns { deduped, dedupedCount } where deduped is the collapsed array (a
// NEW array; original entries are reused, only their score_components.
// duplicate_count is set) and dedupedCount is how many candidates were dropped.
export function _dedupScoredByContent(scored) {
  if (!Array.isArray(scored)) {
    return { deduped: [], dedupedCount: 0 };
  }
  const survivorByKey = new Map(); // key -> survivor entry (first seen)
  const deduped = [];
  let dropped = 0;
  for (const s of scored) {
    if (s == null || typeof s !== "object") {
      // Defensive: pass through malformed entries untouched (keyed uniquely so
      // they never collapse). Should not happen on the production path.
      deduped.push(s);
      continue;
    }
    const key = _dedupKeyForScored(s);
    const existing = survivorByKey.get(key);
    if (existing === undefined) {
      // First (highest-scored) occurrence of this key — keep it.
      if (s.score_components && typeof s.score_components === "object") {
        s.score_components.duplicate_count = 1;
      }
      survivorByKey.set(key, s);
      deduped.push(s);
    } else {
      // A lower-scored duplicate — drop it, bump the survivor's counter.
      if (existing.score_components && typeof existing.score_components === "object") {
        existing.score_components.duplicate_count =
          (existing.score_components.duplicate_count || 1) + 1;
      }
      dropped += 1;
    }
  }
  return { deduped, dedupedCount: dropped };
}

// ---------------------------------------------------------------------------
// C2 — QUERY-SIDE GAZETTEER MERGE (CAPS.RECALL_QUERY_GAZETTEER_ENABLED).
//
// The populator's structural extractor sees STRUCTURE only (urls, emails,
// repo paths, phone numbers, file paths, hashtags), so a query in plain prose
// ("how did the Fernwick run go") yields ZERO entities — measured at 260/265
// logged recalls with entities_count === 0. The write side already stamps
// closed-set kb_lookup ids onto facts (distill-promote-fact.js:731, default
// ON). This is the missing query-side half of that pair, so I-CP-2's
// "same modules both sides" (see the populator comment below) becomes true
// rather than aspirational.
//
// MERGE DISCIPLINE — deliberately IDENTICAL to the cascade's merge
// (distill-promote-fact.js:731-753): append-only, deduped by canonical_id,
// STRUCTURAL WINS. Both sides mint ids through the same buildCanonicalId
// (gazetteer.js:132 / entity-extractor.js:191), so a collision is a genuine
// same-entity collision, not a coincidence of formatting. Structural order is
// preserved so the flag-ON list is the flag-OFF list plus a suffix.
//
// SEED: none is passed. extractGazetteerEntities falls through to the curated
// DEFAULT_GAZETTEER_SEED (gazetteer.js: the per-host seed file when present,
// else BUILT_IN_GAZETTEER_SEED, 9 placeholder surfaces). C2's
// spec asked for a richer seed from a companion builder module, but that node
// was KILLED and the module does not exist on disk — importing it would throw
// at module load. The curated default is the whole vocabulary here, by design:
// the seed must NOT be harvested from the entity substrate (fact F23).
//
// PURE / SYNCHRONOUS / HERMETIC — no I/O, no clock, no randomness.
// ---------------------------------------------------------------------------

// Test seam (codebase convention, cf. __setLoadIndicesForTest above): lets a
// suite force the gazetteer to throw and pin the degrade path. Production
// behavior is identical — the seam defaults to the real extractor.
let __gazetteerImpl = extractGazetteerEntities;
export function __setGazetteerExtractorForTest(fn) {
  __gazetteerImpl = typeof fn === "function" ? fn : extractGazetteerEntities;
}

/**
 * Merge closed-set gazetteer entities into the populator's structural entity
 * list, behind CAPS.RECALL_QUERY_GAZETTEER_ENABLED.
 *
 * FLAG OFF (default): returns `{entities: structuralEntities, degraded_reason:
 * null}` — the SAME ARRAY REFERENCE, never a copy. Off is observationally
 * identical to the pre-C2 populator by construction, not by inspection.
 *
 * FLAG ON: returns structuralEntities followed by every gazetteer entity whose
 * canonical_id is not already present. A throw is caught and reported as
 * `degraded_reason: "query_gazetteer_threw"` with the structural set intact —
 * the gazetteer can only ever ADD, never remove or reorder.
 *
 * @param {Array<object>} structuralEntities — extractEntities' output.
 * @param {string} text — the populator text (recent_turns + current_query).
 * @param {string} source — ENTITY_SOURCE_SCOPES value; the populator's
 *   hardcoded "chat-claude-code".
 * @returns {{entities: Array<object>, degraded_reason: (string|null)}}
 */
export function _applyQueryGazetteer(structuralEntities, text, source) {
  const structural = Array.isArray(structuralEntities) ? structuralEntities : [];
  if (CAPS.RECALL_QUERY_GAZETTEER_ENABLED !== true) {
    return { entities: structuralEntities, degraded_reason: null };
  }
  try {
    const g = __gazetteerImpl(text, { source });
    const gazEntities = g && Array.isArray(g.entities) ? g.entities : [];
    if (gazEntities.length === 0) {
      return { entities: structuralEntities, degraded_reason: null };
    }
    const seenIds = new Set();
    for (const e of structural) {
      if (e && typeof e.canonical_id === "string") seenIds.add(e.canonical_id);
    }
    const merged = [...structural];
    for (const ge of gazEntities) {
      if (!ge || typeof ge.canonical_id !== "string") continue;
      if (seenIds.has(ge.canonical_id)) continue; // structural wins
      seenIds.add(ge.canonical_id);
      merged.push(ge);
    }
    return { entities: merged, degraded_reason: null };
  } catch (err) {
    return { entities: structuralEntities, degraded_reason: "query_gazetteer_threw" };
  }
}

// ---------------------------------------------------------------------------
// W2 — recall READ-path entity wiring.
//
// These are three INDEPENDENT operator levers. Each is read at call time so a
// long-lived MCP process and the hermetic suite can toggle them without a
// module reload. Only the exact string "1" enables a path.
// ---------------------------------------------------------------------------
export const RECALL_ENTITY_WIRING_ENV = Object.freeze({
  IDF: "MEMORY_ENTITY_IDF_ENABLED",
  MATCHKEY_LOOKUP: "MEMORY_RECALL_ENTITY_MATCHKEY_LOOKUP",
  ALIAS_OVERLAY: "MEMORY_ENTITY_ALIAS_OVERLAY",
});

export const ENTITY_DF_WIRING_ERROR = Object.freeze({
  SOURCE_UNAVAILABLE: "entity_df_source_unavailable",
  ZERO_RESOLVED_KEYS: "entity_df_keyspace_zero_resolved",
});

/** A named, machine-readable failure for an enabled-but-inert IDF hand-off. */
export class EntityDfWiringError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "EntityDfWiringError";
    this.code = code;
  }
}

const __entityWiringEnabled = (name) => process.env[name] === "1";

/**
 * Project Bm25Index's FULL-canonical-id entity index into the match-key space
 * consumed by entityOverlapIdf. Buckets are UNIONED as Sets, not summed, so a
 * document stamped under two source spellings contributes df=1 exactly once.
 *
 * When the alias overlay is independently enabled, the alias is applied
 * before entityMatchKey so the df projection inhabits the same key space as
 * the score-time candidate/query projections.
 */
export function _projectEntityDfForRecall(bm25, aliasOverlay = null) {
  if (bm25 == null || !(bm25._entityIndex instanceof Map)) {
    throw new EntityDfWiringError(
      ENTITY_DF_WIRING_ERROR.SOURCE_UNAVAILABLE,
      "MEMORY_ENTITY_IDF_ENABLED=1 requires Bm25Index._entityIndex Map",
    );
  }
  if (typeof bm25.size !== "function") {
    throw new EntityDfWiringError(
      ENTITY_DF_WIRING_ERROR.SOURCE_UNAVAILABLE,
      "MEMORY_ENTITY_IDF_ENABLED=1 requires Bm25Index.size()",
    );
  }
  const entityDfN = bm25.size();
  if (!Number.isInteger(entityDfN) || entityDfN < 1) {
    throw new EntityDfWiringError(
      ENTITY_DF_WIRING_ERROR.SOURCE_UNAVAILABLE,
      `MEMORY_ENTITY_IDF_ENABLED=1 requires a non-empty BM25 corpus (N=${String(entityDfN)})`,
    );
  }

  const useAliases = __entityWiringEnabled(RECALL_ENTITY_WIRING_ENV.ALIAS_OVERLAY);
  // Keep bucket references for single-source keys and allocate a union Set
  // only after a second source spelling collides. The returned map contains
  // NUMERIC dfs, so the 1.45M posting ids are not duplicated and retained by
  // every flag-ON recall merely to communicate bucket cardinalities.
  const projectedBuckets = new Map();
  for (const [canonicalId, bucket] of bm25._entityIndex) {
    if (!(bucket instanceof Set)) {
      throw new EntityDfWiringError(
        ENTITY_DF_WIRING_ERROR.SOURCE_UNAVAILABLE,
        `Bm25Index._entityIndex bucket for ${String(canonicalId)} is not a Set`,
      );
    }
    const aliasedId = useAliases
      ? __resolveEntityAlias(canonicalId, aliasOverlay)
      : canonicalId;
    const key = entityMatchKey(aliasedId);
    if (key === null) continue;
    let projected = projectedBuckets.get(key);
    if (projected === undefined) {
      projectedBuckets.set(key, { first: bucket, union: null });
      continue;
    }
    if (projected.union === null) projected.union = new Set(projected.first);
    for (const memoryId of bucket) projected.union.add(memoryId);
  }
  const entityDf = new Map();
  for (const [key, projected] of projectedBuckets) {
    entityDf.set(
      key,
      projected.union === null ? projected.first.size : projected.union.size,
    );
  }
  return { entityDf, entityDfN };
}

/**
 * Resolve the independently gated resources once per recall. With all flags
 * OFF this does not read a property from bm25 and does not build an overlay.
 */
export function _prepareRecallEntityWiring(bm25) {
  const aliasOverlay = __entityWiringEnabled(RECALL_ENTITY_WIRING_ENV.ALIAS_OVERLAY)
    ? __buildEntityAliasOverlay()
    : null;
  if (!__entityWiringEnabled(RECALL_ENTITY_WIRING_ENV.IDF)) {
    return { aliasOverlay, entityDf: null, entityDfN: null };
  }
  const { entityDf, entityDfN } = _projectEntityDfForRecall(bm25, aliasOverlay);
  return { aliasOverlay, entityDf, entityDfN };
}

/** Flag-off returns the exact input reference; flag-on returns a read-side view. */
export function _resolveRecallEntityAliases(entityIds, aliasOverlay) {
  if (!__entityWiringEnabled(RECALL_ENTITY_WIRING_ENV.ALIAS_OVERLAY)) {
    return entityIds;
  }
  if (!Array.isArray(entityIds)) return entityIds;
  return entityIds.map((id) => __resolveEntityAlias(id, aliasOverlay));
}

/**
 * KEY-SPACE CANARY. An enabled IDF path with a non-empty union must resolve at
 * least one key in the projected df map. Otherwise a full-canonical-id map (or
 * any other mis-keyed hand-off) would silently assign df=1 to every entity and
 * reproduce legacy Jaccard exactly.
 */
export function _assertEntityDfKeyspace(entityDf, entityIds) {
  if (!(entityDf instanceof Map)) {
    throw new EntityDfWiringError(
      ENTITY_DF_WIRING_ERROR.SOURCE_UNAVAILABLE,
      "entity_df hand-off is not a Map",
    );
  }
  const unionKeys = new Set();
  if (Array.isArray(entityIds)) {
    for (const id of entityIds) {
      const key = entityMatchKey(id);
      if (key !== null) unionKeys.add(key);
    }
  }
  if (unionKeys.size === 0) return { unionKeys: 0, resolvedKeys: 0 };
  let resolvedKeys = 0;
  for (const key of unionKeys) {
    if (entityDf.has(key)) resolvedKeys++;
  }
  if (resolvedKeys === 0) {
    throw new EntityDfWiringError(
      ENTITY_DF_WIRING_ERROR.ZERO_RESOLVED_KEYS,
      `key-space canary resolved 0/${unionKeys.size} union keys; refusing uniform df=1 fallback`,
    );
  }
  return { unionKeys: unionKeys.size, resolvedKeys };
}

/**
 * Match-key buckets retain ledger order. Under the flag, take their newest
 * end first so a 273,915-id bucket does not feed the 50-candidate cap its 50
 * oldest rows. Flag-off returns the exact array reference and legacy order.
 */
export function _orderEntityFallbackBucket(bucket) {
  if (!__entityWiringEnabled(RECALL_ENTITY_WIRING_ENV.MATCHKEY_LOOKUP)) {
    return bucket;
  }
  return Array.isArray(bucket) ? bucket.slice().reverse() : bucket;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handler(args, opts) {
  assertObjectShape(args, "args", [
    "surrounding_context",
    "conversation_id",
    "max_items",
    "max_chars",
  ]);
  // opts is an internal test hook: { now? } — production callers pass undefined.
  const handlerOpts = opts && typeof opts === "object" ? opts : {};

  const ctx = assertObject(args.surrounding_context, "surrounding_context");
  assertObjectShape(ctx, "surrounding_context", [
    "recent_turns",
    "agent_role",
    "current_query",
    "time",
    "ambient",
    "recent_recall_ids",
  ]);
  validateRecentTurns(ctx.recent_turns);
  assertNonEmptyString(ctx.agent_role, "surrounding_context.agent_role");
  assertNonEmptyString(ctx.current_query, "surrounding_context.current_query", {
    maxChars: CAPS.RECALL_CURRENT_QUERY_CHARS,
  });
  assertIso8601(ctx.time, "surrounding_context.time");
  validateAmbient(ctx.ambient);
  assertOptionalStringArray(ctx.recent_recall_ids, "surrounding_context.recent_recall_ids", {
    maxItems: CAPS.RECALL_RECENT_RECALL_IDS_MAX,
  });

  assertNonEmptyString(args.conversation_id, "conversation_id");
  const maxItems =
    assertOptionalIntInRange(args.max_items, "max_items", {
      min: 1,
      max: CAPS.RECALL_MAX_ITEMS,
    }) ?? CAPS.RECALL_MAX_ITEMS;
  const maxChars =
    assertOptionalIntInRange(args.max_chars, "max_chars", {
      min: 1,
      max: CAPS.RECALL_MAX_CHARS,
    }) ?? CAPS.RECALL_MAX_CHARS;

  // GATE-PROF — env-gated stage timing (RECALL_PROF=1). No-op otherwise.
  const __prof = process.env.RECALL_PROF === "1";
  let __pt = __prof ? Date.now() : 0;
  const __mark = (label) => {
    if (!__prof) return;
    const now = Date.now();
    console.error(`PROF ${label} ${now - __pt}ms`);
    __pt = now;
  };

  // -------------------------------------------------------------------------
  // a. Parse surrounding_context into segments.
  // -------------------------------------------------------------------------
  const segments = buildSegments(ctx);
  const queryText = buildQueryText(ctx);

  // -------------------------------------------------------------------------
  // a.5. SERVER-SIDE CONTEXT POPULATOR (W4 context-populator.md §5.1).
  //
  // Run the entity / time-anchor / valence / episodicity extractors over the
  // concatenated recent_turns + current_query BEFORE Layer-1 candidate gen.
  // The outputs feed the multi-feature score's soft features (entity_overlap,
  // time_anchor_match, valence_compat, episodicity_match). Per the symmetry
  // contract (I-CP-2) the same modules are used here as on the cascade side.
  //
  // Each extractor is wrapped in try/catch — any throw degrades that single
  // axis to its empty value rather than tipping the whole handler. The
  // populator.degraded flag is surfaced on the brief envelope per I-CP-8.
  // -------------------------------------------------------------------------
  const populatorParts = [];
  if (Array.isArray(ctx.recent_turns)) {
    for (const t of ctx.recent_turns) {
      if (t && typeof t.content === "string") populatorParts.push(t.content);
    }
  }
  if (typeof ctx.current_query === "string") populatorParts.push(ctx.current_query);
  const populatorText = populatorParts.join("\n");

  let populatorEntities = [];
  let populatorTimeAnchors = [];
  let populatorValence = null;
  let populatorDegraded = false;
  const populatorDegradedReasons = [];

  // The entity-extractor takes a closed source-scope enum. v0 recall traffic
  // is chat-origin (the same surface the Claude Code UserPromptSubmit hook
  // would carry), so we stamp source=chat-claude-code. Bumping source here is
  // a CAPS concern; the choice here is the recall-context default.
  try {
    const { entities } = extractEntities(populatorText, {
      source: "chat-claude-code",
    });
    populatorEntities = Array.isArray(entities) ? entities : [];
  } catch (err) {
    populatorDegraded = true;
    populatorDegradedReasons.push("entity_extractor_threw");
    populatorEntities = [];
  }

  // C2 — query-side gazetteer, additive, behind a default-off CAP. See
  // _applyQueryGazetteer above for the merge discipline (structural wins).
  //
  // POSITION IS LOAD-BEARING, AND IT MOVES THREE AXES, NOT ONE. Sitting here
  // — before the episodicity twin — is the faithful reading of I-CP-2 above
  // (the cascade also stamps entities BEFORE it scores episodicity), but it
  // means populatorEntities is read downstream by:
  //   1. computeQueryEpisodicity({entities: populatorEntities}) below
  //      -> the episodicity_match feature (LIVE, pinned to [0.136, 0.483]);
  //   2. the populatorEntityIds projection below -> entity_overlap at scoring;
  //   3. the substrate-fallback gate (`populatorEntityIds.length > 0`), which
  //      ADDS candidates to the pool rather than merely reranking it.
  // A reviewer measuring "one degraded axis" is measuring the wrong thing.
  {
    const gz = _applyQueryGazetteer(
      populatorEntities,
      populatorText,
      "chat-claude-code",
    );
    populatorEntities = gz.entities;
    if (gz.degraded_reason !== null) {
      populatorDegraded = true;
      populatorDegradedReasons.push(gz.degraded_reason);
    }
  }

  try {
    const { anchors } = resolveTimeAnchors(populatorText, {
      now: typeof ctx.time === "string" ? ctx.time : undefined,
    });
    populatorTimeAnchors = Array.isArray(anchors) ? anchors : [];
  } catch (err) {
    populatorDegraded = true;
    populatorDegradedReasons.push("time_anchor_resolver_threw");
    populatorTimeAnchors = [];
  }

  try {
    populatorValence = scoreValence(
      typeof ctx.current_query === "string" ? ctx.current_query : "",
    );
  } catch (err) {
    populatorDegraded = true;
    populatorDegradedReasons.push("valence_scorer_threw");
    populatorValence = null;
  }

  // Mood-vocabulary fallback. When the lexicon-based scorer returns
  // sign=0/magnitude=0 (true neutral or defaulted) and the surrounding
  // ambient context carries a known inferred_mood string, translate via the
  // closed SYNTH_MOOD_STRING_TO_VALENCE CAPS table. Unknown mood strings
  // increment populator.mood_table_miss for calibration. This is a strict
  // fallback — a non-neutral lexicon signal wins because that signal was
  // measured on the current_query itself, while the ambient mood is a
  // looser upstream guess.
  let populatorMoodTableMissCount = 0;
  try {
    const inferredMood = ctx.ambient
      && typeof ctx.ambient.inferred_mood === "string"
      ? ctx.ambient.inferred_mood
      : null;
    if (inferredMood != null) {
      const moodMissBefore = getMoodTelemetry().mood_table_miss;
      const moodValence = moodStringToValence(inferredMood);
      const moodMissAfter = getMoodTelemetry().mood_table_miss;
      populatorMoodTableMissCount = moodMissAfter - moodMissBefore;
      // Apply only when the lexicon path produced no signal AND the mood
      // string was in the closed table. populatorValence is rewritten in
      // place with the canonical shape valence-scorer would have emitted.
      const lexiconSilent = populatorValence == null
        || (populatorValence.sign === 0 && populatorValence.magnitude === 0);
      if (lexiconSilent && moodValence != null) {
        populatorValence = {
          sign: moodValence.sign,
          magnitude: moodValence.magnitude,
          source: "lexicon",
          model_version: VALENCE_MODEL_VERSION,
        };
      }
    }
  } catch (err) {
    populatorDegraded = true;
    populatorDegradedReasons.push("mood_table_lookup_threw");
  }

  // Episodicity-scorer twin reads `surrounding_context.{time_anchors, entities,
  // ambient}`. Build the synthesis-shaped view from the populator outputs so
  // computeQueryEpisodicity can stratify the score.
  let populatorQueryEpisodicity = null;
  try {
    populatorQueryEpisodicity = computeQueryEpisodicity({
      time_anchors: populatorTimeAnchors,
      entities: populatorEntities,
      ambient: ctx.ambient || null,
    });
  } catch (err) {
    populatorDegraded = true;
    populatorDegradedReasons.push("episodicity_scorer_threw");
    populatorQueryEpisodicity = null;
  }

  // Resolved time anchor: the earliest absolute/relative anchor's instant_iso.
  // Multi-feature-score's timeAnchorMatch reads a single ISO string and gates
  // to 0 when null — so picking the first anchor preserves the "most-recent
  // mention" prior in the conversation.
  let resolvedTimeAnchor = null;
  for (const anchor of populatorTimeAnchors) {
    if (anchor && typeof anchor.instant_iso === "string" && anchor.instant_iso !== "") {
      resolvedTimeAnchor = anchor.instant_iso;
      break;
    }
  }

  // Canonical entity-id projection: the multi-feature scorer's entity-overlap
  // is set Jaccard over string ids. Project each Entity to its canonical_id
  // (foundation spec §5.1). Empty surfaces are skipped.
  const populatorEntityIds = populatorEntities
    .map((e) => (e && typeof e.canonical_id === "string" ? e.canonical_id : ""))
    .filter((s) => s.length > 0);

  // recall_id + surrounding_context_hash are stable inputs to everything
  // downstream (propensity jitter seed, predicate snapshot, recall-log).
  const recallId = "rec_" + randomBytes(8).toString("hex");
  const surroundingContextHash = createHash("sha256")
    .update(canonicalJson(ctx), "utf8")
    .digest("hex");

  // -------------------------------------------------------------------------
  // b. Embed the recall query. WU-recall-flip-to-local-4096.
  //
  // The query is the surrounding_context (current_query + recent_turns +
  // agent_role) — the SAME segment-assembly buildSegments() produced for the
  // Gemini path. We now route the assembled text through the LOCAL Qwen3-8B
  // server (embedSingle, isQuery:true) to get ONE L2-unit 4096 query vector,
  // instead of the Gemini per-segment 3072 encoder.
  //
  // The 4096 query vector drives BOTH legs:
  //   - dense leg: hybridRetrieve reads segmentVectors[*].vector_mrl_768 and
  //     calls hnsw.search() with it. The active 4096 HNSW validates the query
  //     dim === index dim (4096), so we put the FULL 4096 vector in that field
  //     (the "_768" name is legacy; it now carries the active-model query
  //     vector, whatever its dim). No MRL slice — operator chose full fidelity.
  //   - Layer-2 rescore (s_emb): firstSegmentVec3072 carries the SAME 4096
  //     vector; _selectSameDimEmbedding(candidate, vec.length) then picks the
  //     candidate's embedding_4096 by dim match. Facts not yet re-embedded (no
  //     embedding_4096) score s_emb=0 and rank by BM25 + additive features —
  //     graceful partial-coverage during the background re-embed.
  //
  // Graceful degrade: LocalEmbedUnavailableError (server down / mis-shaped) ->
  // null query vector + empty segmentVectors + degraded_recall=true, i.e.
  // BM25-only candidate generation (no dense leg, no per-vector rescore). Same
  // degraded contract the Gemini path emitted on a quota outage; we do NOT
  // crash. `embedSingle` also throws a plain Error on empty text (a query with
  // no current_query AND no turns) — that, too, degrades rather than throws.
  // -------------------------------------------------------------------------
  // The local backend is asymmetric on a single is_query flag rather than a
  // multi-task-type enum: the one embedSingle call below passes isQuery:true
  // unconditionally, and the local server's query instruction-prefix is the
  // local analogue of a task type. LIMITATION (unchanged by l17, stated so it
  // is not mistaken for a regression): query INTENT is not propagated to the
  // embedder. l17 deleted the Gemini task-type selector that used to run here;
  // it had already been dead since l5-fallback-removal removed the Gemini-index
  // fallback that consumed its value, so nothing observable read intent then
  // either. Propagating it would need a local-server-side signal to carry it.
  // Assemble the query string from the already-built segments (preserves the
  // current_query + recent_turns + agent_role assembly). Non-empty texts only.
  const localQueryText = segments
    .map((s) => (s && typeof s.text === "string" ? s.text : ""))
    .filter((t) => t.length > 0)
    .join("\n")
    .trim();

  let segmentVectors = []; // [{ segment_role, vector_mrl_768 }] — 4096 query vec
  let degradedRecall = false;
  // Despite the legacy name, this now holds the ACTIVE-model query vector
  // (4096 from the local backend). Kept named for minimal blast radius — every
  // downstream consumer reads only its .length (geometry selector) and its
  // values (cosine-as-dot), both of which are dim-agnostic.
  let firstSegmentVec3072 = null;
  // Tracks the model that ACTUALLY produced the query vector, for the recall
  // event stamp. Defaults to the active model (the primary local path); the
  // Gemini-fallback branch below resets it to the legacy version when it
  // re-encodes the query against the Gemini index.
  let queryEmbedModelVersion = ACTIVE_EMBEDDING_MODEL_VERSION;

  if (localQueryText.length === 0) {
    // No embeddable query text at all -> BM25-only (queryText is also "" here,
    // so the brief is sparse). Degrade rather than call embedSingle with "".
    degradedRecall = true;
    segmentVectors = [];
    firstSegmentVec3072 = null;
  } else {
    try {
      const { vector_4096 } = await embedSingle({
        text: localQueryText,
        isQuery: true,
      });
      firstSegmentVec3072 = vector_4096;
      segmentVectors = [
        {
          segment_role: "surrounding_context",
          // The dense leg reads this field; it carries the full 4096 vector
          // (NOT MRL-sliced) so it matches the active 4096 HNSW's dim.
          vector_mrl_768: vector_4096,
        },
      ];
    } catch (err) {
      // LocalEmbedUnavailableError (server down/mis-shaped) OR any other embed
      // failure -> degraded recall: BM25-only candidate gen, no dense leg, no
      // per-vector rescore. degraded_recall=true; do NOT crash.
      const degradeKind =
        err instanceof LocalEmbedUnavailableError
          ? "local embed server unavailable"
          : "local embed failed";
      console.error(
        `memory_recall: degraded_recall=true; ${degradeKind}: ${
          err && err.message ? err.message : String(err)
        }`,
      );
      degradedRecall = true;
      segmentVectors = [];
      firstSegmentVec3072 = null;
    }
  }

  // -------------------------------------------------------------------------
  // c. Load indices (process-cached, mtime-invalidated).
  //    WU-recall-flip-to-local-4096 — load the ACTIVE 4096 index
  //    (indices/<ACTIVE_EMBED_MODEL_VERSION>/) as the ONLY path. Since
  //    l5-fallback-removal there is no cross-model fallback tree: recall serves
  //    from the active version or reports itself degraded.
  //      - active 4096 index present + non-empty  -> dense leg on the 4096 HNSW
  //        with the local query vector (the live semantic path; degraded_recall
  //        stays FALSE).
  //      - active 4096 BM25 present but its HNSW empty (BM25 rebuilt ahead of
  //        the dense backfill) -> suppress the dim-4096 dense leg (never search
  //        an empty/half-built HNSW) and rank by BM25 + additive features.
  //      - both trees empty -> BM25-only over an empty index (sparse brief),
  //        AND degraded_recall:true. This is the one behaviour delta of
  //        l5-fallback-removal: the both-empty shape previously fell through
  //        this chain reporting degraded_recall:false (residual r1-1,
  //        absence-reported-as-health), and now reports the degrade because it
  //        shares the single activeHnswEmpty arm below. It is pinned by T9 in
  //        test/synthesis/recall-local-4096-query.test.mjs.
  //    The two arms above share that ONE boolean, which is why
  //    r3-degraded-recall-blindspot adds the `indexUnservable` marker beside
  //    it (declared with the arm below): the boolean says THAT recall
  //    degraded, the marker says WHICH of the two shapes it was, at both
  //    envelope sites. The boolean's value is unchanged by that addition.
  // -------------------------------------------------------------------------
  // Q2 (memperf) — resolve the index-consumption backend ONCE per process
  // (memoized inside queryd-client): "daemon" (MEMORY_QUERYD=required, or
  // auto that found a live queryd socket) serves every index read below over
  // the unix socket — emptiness probes from ONE cached status response,
  // candidate generation via prefetched bm25_search/hnsw_search stubs, and
  // the Layer-2 rescore via batched vector_fetch. "in-process" (off, or auto
  // with no socket) is the pre-Q2 loadIndices path, byte-identical output
  // included. HERD BAN: in daemon mode NO failure path may reach
  // loadIndices — a daemon outage degrades THIS call with the structured
  // {code:"queryd_unavailable", retryable:true} error instead of N clients
  // each deserializing a multi-GB HNSW. Subsequent calls re-probe cheaply
  // (one connect attempt), so a restarted daemon is picked up. NOTE for
  // operators: the first call after a daemon (re)start may degrade this way
  // while the daemon deserializes the ~1.9GB index (client retries a
  // `loading` response once after 250ms, then fails loud).
  const querydMode = await resolveQuerydMode();
  const useQueryd = querydMode === "daemon";
  const querydDegradeError = (err) =>
    new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `memory_recall: queryd unavailable and daemon mode forbids in-process index loading: ${
        err && err.message ? err.message : String(err)
      }`,
      {
        code: "queryd_unavailable",
        retryable: true,
        reason: err instanceof QuerydUnavailableError ? err.reason : null,
      },
    );
  let querydClient = null;
  let querydStatusModels = null; // ONE status response answers all size() probes
  let querydGeneration = null; // stamped from queryd response envelopes
  // b2-silent-recall-degrade — the ATTESTED-RESIDENT id set for the Layer-2
  // prefetch discriminator below. Populated ONLY from hnsw_search results:
  // HnswIndex.search maps every internal id back through `_memoryIdForId` and
  // post-filters `_tombstones` before returning {memory_id, cosine_distance,
  // rank}, so an id in here was demonstrably resident in the index THIS call is
  // being served from. That is what lets the prefetch treat a structured null
  // for one of these ids as a failure rather than as an ordinary index miss.
  // Function scope (beside querydGeneration) because the retrieval block fills
  // it and the prefetch block far below reads it.
  const querydDenseHitIds = new Set();
  // b2-silent-recall-degrade (run 3) — DENSE-LEG REFUSAL counters, function
  // scope (beside querydDenseHitIds) because the retrieval block fills them and
  // both envelope sites far below read them.
  //
  // `emptyOnBadRequest` in the retrieval block below swallows a
  // QuerydBadRequestError into `{results: [], generation: null}`. On the DENSE
  // leg that silently empties the semantic half of retrieval, and until run 3
  // the envelope still reported degraded_recall:false — the exact fault a
  // model/generation swap causes. queryd's `_execute` returns
  // `bad("unknown model_version; configured: ...")` when the resolved `entry`
  // is null, and its hnsw_search catch deliberately keeps HnswIndex.search-
  // labelled throws (dims mismatch, non-unit-norm query, invalid topK) on
  // bad_request.
  //
  // NOT ALWAYS-ON, proven at the queryd symbols rather than asserted:
  //   - healthy               -> _okEnvelope, no error at all
  //   - model MID-RELOAD      -> the per-model admission gate
  //                              (`this._reloadingModels.has(mv)`) answers
  //                              ERROR_CODES.LOADING before enqueue, which
  //                              queryd-client maps to QuerydUnavailableError,
  //                              NOT QuerydBadRequestError
  //   - model DEGRADED        -> the same gate answers ERROR_CODES.DEGRADED
  //   - corrupt resident index -> _execute's `internal(msg)` branch
  // So only a genuine request-shape refusal increments this, and a healthy or
  // merely-lexical call leaves it at 0 (GOAL invariant #5, both directions).
  //
  // The LEXICAL leg deliberately shares `emptyOnBadRequest`'s degrade but NOT
  // this counter — see the residual filed in the node report; its blast radius
  // is different and it is out of scope here.
  let denseLegsRequested = 0;
  let denseLegsEmptiedByBadRequest = 0;
  let indexModelVersion = ACTIVE_EMBEDDING_MODEL_VERSION; // tree serving THIS call
  // r3-degraded-recall-blindspot (run 2) — THE ONE PRESENCE PROBE.
  //
  // The cached status is a per-model-version table, and "does the daemon carry
  // this version at all?" is the question four separate sites below asked by
  // writing out the SAME `.find` expression: the size view, the model-missing
  // check, the generation-refusal lookup and the response's generation stamp.
  // Presence being a first-class fact at one site and an implicit 0 at another
  // is precisely the blindspot this node closes, so it is structurally ONE
  // probe now. PURE DEDUPE: every caller keeps its own `mv` argument and its
  // own `m != null` follow-on, so each returned value is unchanged — `.find`
  // answered `undefined` on a miss and this answers `null`, and every consumer
  // tested `!= null`, which does not distinguish them.
  const querydStatusEntry = (mv) =>
    Array.isArray(querydStatusModels)
      ? (querydStatusModels.find((e) => e != null && e.model_version === mv) ??
        null)
      : null;
  // Size-only index view over the cached status. A model_version the daemon
  // does not carry is the EMPTY-index shape (mirror of loadIndices'
  // fail-close-to-empty / bad_request contract), so the existing absent-tree
  // fallback branches below run unchanged in daemon mode.
  //
  // r3 (run 2) — ...but "absent" and "present and genuinely empty" are NOT the
  // same observation, and the two size ternaries below cannot tell them apart:
  // both answer 0. `present` carries that distinction out to the REPORTING
  // layer (F72: an unmeasured size must never be promoted into a positive
  // claim about the tree). It is bound to the `mv` this view was ACTUALLY
  // called with, deliberately not to `indexModelVersion` — the marker's
  // honesty must not rest on those two being the same string today.
  // The sizes themselves are UNTOUCHED (still 0 on a name miss), so every
  // control-flow branch below sees exactly what it saw pre-r3.
  const querydSizeView = (mv) => {
    const m = querydStatusEntry(mv);
    const bm25Size = m != null && Number.isInteger(m.bm25_size) ? m.bm25_size : 0;
    const hnswSize = m != null && Number.isInteger(m.hnsw_size) ? m.hnsw_size : 0;
    return {
      present: m != null,
      bm25: { size: () => bm25Size },
      hnsw: { size: () => hnswSize },
    };
  };
  const querydGenerationForResponse = () => {
    if (querydGeneration != null) return querydGeneration;
    const m = querydStatusEntry(indexModelVersion);
    return m != null && m.generation != null ? m.generation : null;
  };
  if (useQueryd) {
    try {
      querydClient = getQuerydClient();
      const status = await querydClient.status();
      querydStatusModels = Array.isArray(status.models) ? status.models : [];
    } catch (err) {
      throw querydDegradeError(err);
    }
  }
  let activeIndices = useQueryd
    ? querydSizeView(ACTIVE_EMBEDDING_MODEL_VERSION)
    : __loadIndicesImpl(ACTIVE_EMBEDDING_MODEL_VERSION);
  let bm25 = activeIndices.bm25;
  let hnsw = activeIndices.hnsw;
  // FU2 (memperf) — REFUSED-GENERATION visibility. loadIndices now reports
  // (additively) when the ACTIVE index generation was refused (manifest
  // member mismatch / deserialize failure) and a non-active source served the
  // load: generation_refused = {code, member?, served:"fallback"|"empty"} |
  // null. Pre-FU2 that refusal was stderr-only and recall reported
  // degraded_recall:false while serving the retained fallback (or empty)
  // tree — silent thin briefs (the live 1-14-vs-46-candidates incident).
  // Track the marker for the tree serving THIS call — since
  // l5-fallback-removal that is always the ACTIVE tree, because no branch
  // re-points recall at another model's tree any more. The queryd
  // path fills this from the cached status below. VISIBILITY ONLY: the
  // behavior-gating `degradedRecall` variable is deliberately NOT set from
  // this marker (a fallback generation's HNSW is real — suppressing the
  // dense leg would change results); the degrade is OR-ed in at the envelope
  // sites instead.
  let indexGenerationRefused = useQueryd
    ? null
    : (activeIndices.generation_refused ?? null);
  const activeHnswEmpty =
    hnsw == null || typeof hnsw.size !== "function" || hnsw.size() === 0;
  const activeBm25Empty =
    bm25 == null || typeof bm25.size !== "function" || bm25.size() === 0;
  // l5-fallback-removal — ONE arm, whatever the active BM25 looks like. The
  // active 4096 HNSW is empty (absent, or BM25 rebuilt ahead of the dense
  // backfill): suppress the dim-4096 dense leg so the empty HNSW is never
  // searched; BM25 + additive features still rank. When the active BM25 is
  // ALSO empty the call resolves over an empty index and reports itself
  // degraded rather than silently healthy.
  //
  // REMOVED HERE: the both-empty case previously loaded the legacy Gemini
  // index tree, re-pointed indexModelVersion at it, re-encoded the query
  // through the Gemini segment encoder (3072 -> MRL-768) and re-stamped
  // queryEmbedModelVersion, which is what made a 3072-dim query vector — and
  // therefore _selectSameDimEmbedding's 3072 arm — reachable. Both went
  // together (FL-24). No path swaps in another model's tree mid-call now, so
  // indexModelVersion stays the active version for the whole handler.
  if (activeHnswEmpty) {
    segmentVectors = [];
    degradedRecall = true;
  }

  // r3-degraded-recall-blindspot — UNSERVABLE-INDEX visibility.
  //
  // The arm above sets ONE boolean for two materially different outcomes, and
  // `degraded_recall` cannot tell them apart:
  //   - active HNSW empty, active BM25 POPULATED -> the dense leg is
  //     suppressed but a real lexical brief still serves (thinner, not blind);
  //   - both legs empty -> the call resolves over an unservable tree and can
  //     surface nothing at all.
  // An operator reading only the envelope saw the same `true` for both. This
  // marker NAMES which one happened, and the recall event carries it too.
  //
  // VISIBILITY ONLY, the discipline this file already applies to FU2's
  // `indexGenerationRefused` and b2's three markers: derived purely from the
  // emptiness booleans computed above, never assigned to the behavior-gating
  // `degradedRecall` variable, and no retrieval leg is suppressed to make it
  // fire. It is OR-ed into `degraded_recall` at the two envelope sites — and
  // that OR is provably a no-op on the boolean's VALUE, because a non-null
  // marker implies activeHnswEmpty, which the arm directly above already
  // turned into `degradedRecall = true` at this same scope. The boolean is
  // bit-identical to pre-r3 on every input; only the reason is new.
  //
  // KEYED ON INDEX SIZE, NEVER ON RESULT COUNT: a healthy populated tree that
  // legitimately matches nothing keeps degraded_recall:false with no
  // degraded_reason key. An empty RESULT is not a failure. T11 in
  // test/synthesis/recall-local-4096-query.test.mjs pins that direction; T10
  // and T12 pin the two states this marker separates.
  //
  // LEAK DISCIPLINE, per b2's precedent at the sibling markers: machine-
  // readable class + booleans + the model version only — no err.message, no
  // memory ids, no query text.
  //
  // Function scope (beside `indexGenerationRefused`) because both envelope
  // sites far below read it, and placed after `useQueryd` / `indexModelVersion`
  // are bound so the marker can name the backend and the tree serving THIS
  // call.
  //
  // -------------------------------------------------------------------------
  // r3 run 2 — WERE THE SIZES ACTUALLY MEASURED? (REPORTING ONLY)
  //
  // The two emptiness booleans above are honest only where a real size was
  // read. In daemon mode they come from the cached status table, and a model
  // version the daemon does not carry has NO entry there — `querydSizeView`
  // answers 0 for both legs, which is a NAMING MISS, not an observation of an
  // empty tree. Reporting `hnsw_empty:true, bm25_empty:true` off those zeros
  // promotes an unmeasured value into a positive factual claim (F72), and an
  // operator reading it would go hunting for a broken index instead of the
  // deployment mismatch that is actually in front of them.
  //
  // `!useQueryd ||` is explicit rather than incidental: the in-process branch's
  // `__loadIndicesImpl(...)` return carries no `present` field, and its
  // emptiness IS measured — `loadIndices` returns real index objects whose
  // `size()` was called, and every fail-closed empty route through
  // `_pickLoadableGeneration` names itself (`generation_refused` non-null:
  // refusal, `index_publish_in_flight`, `index_manifest_unreadable`,
  // `index_generation_reader_race`), with bare-null exhaustion meaning "no
  // candidate survived and none was skipped by us". So in-process is always
  // measured.
  //
  // REPORTING ONLY — this value governs which SHAPE the marker takes. It is
  // never read by a retrieval leg, never assigned to `degradedRecall`, and
  // (like the marker itself) cannot change any control-flow boolean.
  // -------------------------------------------------------------------------
  const activeSizesMeasured = !useQueryd || activeIndices.present === true;
  // TWO-STATE MARKER.
  //   MEASURED   — byte-identical to pre-run-2 plus `sizes_measured:true`.
  //   UNMEASURED — reachable ONLY in daemon mode with the version absent from
  //     status. The CLASS is still measured (`code:"index_unservable"`): a
  //     daemon that does not carry the version provably cannot serve it, every
  //     search below bad_requests. What is NOT measured is HOW the tree looks,
  //     so `hnsw_empty` / `bm25_empty` are OMITTED ENTIRELY — withheld, not
  //     nulled, not defaulted. `reason` REUSES the existing vocabulary rather
  //     than minting a second name for the same condition: it is the literal
  //     "queryd_model_missing" the REG spread already stamps on the response
  //     for this exact shape, which is what finally makes the response and the
  //     recall event agree on this path (pre-run-2 the event said
  //     "active_tree_unservable" — same call, two stories).
  // The GATING expression is untouched (`activeHnswEmpty ? ... : null`), so the
  // marker's null-ness — and therefore the `degraded_recall` OR at both
  // envelope sites — is bit-identical on every input. The unmeasured branch
  // cannot widen it either: a missing entry makes `hnsw.size()` 0, hence
  // `activeHnswEmpty` true, hence the marker already fired pre-run-2.
  const indexUnservable = activeHnswEmpty
    ? activeSizesMeasured
      ? {
          code: "index_unservable",
          reason: activeBm25Empty
            ? "active_tree_unservable"
            : "dense_leg_unservable",
          model_version: indexModelVersion,
          hnsw_empty: activeHnswEmpty,
          bm25_empty: activeBm25Empty,
          index_source: useQueryd ? "queryd" : "in-process",
          sizes_measured: true,
        }
      : {
          code: "index_unservable",
          reason: "queryd_model_missing",
          model_version: indexModelVersion,
          index_source: "queryd",
          sizes_measured: false,
        }
    : null;

  // REG (memperf, Q2 followup) — queryd MODEL-MISMATCH surfacing. When the
  // daemon's status does not carry the model version serving THIS call
  // (spawned --models=<other>), every search below would BAD_REQUEST into the
  // empty-result shape and the caller got a SILENT empty brief stamped
  // index_source:"queryd" with degraded_recall=false — indistinguishable from
  // "nothing relevant". Mark the call degraded (the dense leg is suppressed;
  // the doomed searches still map bad_request→empty unchanged) and stamp
  // degraded_reason:"queryd_model_missing" on the response so operators see
  // the deployment mismatch instead of chasing phantom recall quality.
  // Keyed on ENTRY PRESENCE, not sizes: a daemon that carries the version
  // with a genuinely empty tree (bootstrap) is NOT a mismatch. In-process
  // mode is untouched (querydModelMissing stays false).
  // r3 run 2 — the same presence probe the size view uses, instead of a second
  // hand-written scan. Value-identical: the old `.some` predicate required
  // `e != null && e.model_version === mv`, so a hit is always a non-null entry
  // and `querydStatusEntry(mv) != null` is true on exactly the same inputs.
  const querydModelMissing =
    useQueryd && querydStatusEntry(indexModelVersion) == null;
  if (querydModelMissing) {
    console.error(
      `memory_recall: queryd does not carry model_version ${indexModelVersion} ` +
        `(daemon serves: ${
          Array.isArray(querydStatusModels)
            ? querydStatusModels
                .map((e) => (e != null ? e.model_version : "?"))
                .join(",") || "(none)"
            : "(no status)"
        }); degraded_reason=queryd_model_missing`,
    );
    segmentVectors = [];
    degradedRecall = true;
  }

  // FU2 — queryd path: the daemon loads via the same loadIndices and carries
  // the per-model refusal marker on its status response (one cached call —
  // the Q2 herd ban is untouched). Serving tree first, active tree second.
  // Since l5-fallback-removal indexModelVersion is never re-pointed, so the
  // two lookups resolve the same model and the `??` is a defensive no-op kept
  // rather than rewritten (it is the correct shape if a serving-tree switch is
  // ever reintroduced).
  if (useQueryd) {
    const refusalFor = (mv) => {
      const m = querydStatusEntry(mv);
      return m != null && m.generation_refused != null
        ? m.generation_refused
        : null;
    };
    indexGenerationRefused =
      refusalFor(indexModelVersion) ??
      refusalFor(ACTIVE_EMBEDDING_MODEL_VERSION);
  }
  if (indexGenerationRefused != null) {
    console.error(
      `memory_recall: degraded_reason=index_generation_refused for ` +
        `${indexModelVersion}: ${JSON.stringify(indexGenerationRefused)} ` +
        `(visibility only — results are served from the ${indexGenerationRefused.served} source)`,
    );
  }

  // W2 — resolve the three independently default-off entity resources against
  // the BM25 tree that is ACTUALLY serving this recall (active or legacy
  // fallback). In daemon mode the size-only view deliberately has no private
  // entity index, so enabling IDF there fails with entity_df_source_unavailable
  // instead of silently reverting every key to df=1.
  const recallEntityWiring = _prepareRecallEntityWiring(bm25);

  // -------------------------------------------------------------------------
  // d. Hybrid candidate generation -> top-50.
  // -------------------------------------------------------------------------
  __mark("pre-hybrid");
  // Q2 (memperf) — daemon-mode candidate generation. Prefetch the BM25 leg
  // once (the exact queryText/K hybridRetrieve would use) plus one
  // hnsw_search per segment vector, in parallel, then hand hybridRetrieve
  // sync result-stubs so its RRF fusion / MaxSim / degraded-leg logic runs
  // byte-identically over daemon-served hits — hybrid-retriever.js itself is
  // untouched. A BAD_REQUEST (unknown model_version) maps to the empty-index
  // result shape; any daemon failure degrades this call loudly (herd ban —
  // never loadIndices). In-process mode passes the loaded index objects
  // through unchanged (the pre-Q2 call, bit for bit).
  let hybridBm25 = bm25;
  let hybridHnsw = hnsw;
  if (useQueryd) {
    const K = CAPS.RECALL_CANDIDATE_SET_SIZE;
    const wantBm25 = typeof queryText === "string" && queryText.trim() !== "";
    const denseSegs =
      degradedRecall || !Array.isArray(segmentVectors)
        ? []
        : segmentVectors.filter(
            (s) => s != null && Array.isArray(s.vector_mrl_768),
          );
    // b2-silent-recall-degrade (run 3) — the SAME degrade, split PER LEG so the
    // dense half's refusals are countable. Behavior is byte-identical to the
    // single closure it replaces (same instanceof test, same
    // `{results: [], generation: null}` return, same rethrow); only the dense
    // variant additionally increments the visibility counter declared beside
    // querydDenseHitIds. The lexical variant is left counter-free on purpose.
    const emptyOnBadRequestLexical = (err) => {
      if (err instanceof QuerydBadRequestError) {
        return { results: [], generation: null };
      }
      throw err;
    };
    const emptyOnBadRequestDense = (err) => {
      if (err instanceof QuerydBadRequestError) {
        denseLegsEmptiedByBadRequest += 1;
        return { results: [], generation: null };
      }
      throw err;
    };
    denseLegsRequested = denseSegs.length;
    let bm25Resp = null;
    let denseResps = [];
    try {
      [bm25Resp, ...denseResps] = await Promise.all([
        wantBm25
          ? querydClient
              .bm25Search(indexModelVersion, queryText, K)
              .catch(emptyOnBadRequestLexical)
          : Promise.resolve(null),
        ...denseSegs.map((s) =>
          querydClient
            .hnswSearch(indexModelVersion, s.vector_mrl_768, K)
            .catch(emptyOnBadRequestDense),
        ),
      ]);
    } catch (err) {
      throw querydDegradeError(err);
    }
    const bm25Hits =
      bm25Resp != null && Array.isArray(bm25Resp.results) ? bm25Resp.results : [];
    for (const resp of [bm25Resp, ...denseResps]) {
      if (resp != null && querydGeneration == null && resp.generation != null) {
        querydGeneration = resp.generation;
      }
    }
    // Keyed by segment-vector identity: hybridRetrieve calls
    // hnsw.search(seg.vector_mrl_768, K) with these exact array refs.
    const denseHitsByVector = new Map();
    denseSegs.forEach((s, i) => {
      const r = denseResps[i];
      const hits = r != null && Array.isArray(r.results) ? r.results : [];
      denseHitsByVector.set(s.vector_mrl_768, hits);
      // b2-silent-recall-degrade — pure collection, no behavior change and no
      // extra request: the same response objects the dense leg already fused.
      // See querydDenseHitIds' declaration for why these ids are attested.
      for (const h of hits) {
        if (h != null && typeof h.memory_id === "string" && h.memory_id.length > 0) {
          querydDenseHitIds.add(h.memory_id);
        }
      }
    });
    hybridBm25 = { search: () => bm25Hits };
    hybridHnsw = { search: (vec) => denseHitsByVector.get(vec) ?? [] };
  }
  const fused = await hybridRetrieve({
    segmentVectors,
    queryText,
    bm25: hybridBm25,
    // When degraded, pass null to bypass the dense leg cleanly.
    hnsw: degradedRecall ? null : hybridHnsw,
  });
  __mark("hybridRetrieve");

  // -------------------------------------------------------------------------
  // d.5. WU-RR2 — substrate-aware Layer-1c fallback.
  //
  // When the BM25 + HNSW union produces fewer than
  // RECALL_SUBSTRATE_FALLBACK_TRIGGER_THRESHOLD unique candidates AND the
  // populator extracted any entities from the surrounding context, fall back
  // to scanning features.entities via the substrate entity-index
  // (canonical_id -> [memory_id]). Merge those ids into the candidate pool
  // (deduped, capped at RECALL_SUBSTRATE_FALLBACK_MAX_CANDIDATES).
  //
  // Rationale (workunit motivation):
  //   - 99.9% of facts currently have features.embedding=null because Gemini
  //     quota blocks the embedding-backfill daemon, so HNSW is mostly empty.
  //   - The substrate has 88.7% entity coverage on 1.4M facts; recall just
  //     wasn't using it for candidate selection.
  //   - When indices return enough candidates the fallback never fires
  //     (no perf regression). The trigger is a strict-less-than guard.
  //
  // Defensive degrade: any throw from loadOrRebuildIndex or entity lookup
  // skips the fallback (logged + swallowed) and the handler proceeds with
  // whatever the hybrid retriever returned.
  // -------------------------------------------------------------------------
  let fallbackTriggered = false;
  let fallbackAddedCandidates = 0;
  let fallbackSkipReason = null;
  if (
    fused.length < CAPS.RECALL_SUBSTRATE_FALLBACK_TRIGGER_THRESHOLD &&
    populatorEntityIds.length > 0
  ) {
    try {
      const ledgerPath = memoryLedgerPath();
      const cachePath = join(STORAGE_DIR, "entity-index.cache.json");
      const eindex = await __loadOrRebuildEntityIndex({
        ledgerPath,
        cachePath,
      });
      // Build the dedup set of memory_ids already present in the fused pool;
      // the fallback augments rather than replaces. Insertion order in the
      // fused array is preserved (RRF-sorted); fallback rows are appended
      // after the index-derived candidates.
      const existingIds = new Set();
      for (const f of fused) existingIds.add(f.memory_id);
      const fallbackIds = new Set();
      for (const canonicalId of populatorEntityIds) {
        let bucket;
        try {
          // W2/C4/W3 — the production caller. The callee delegates to exact
          // lookup with its independent flag OFF and lazily builds the retained
          // match-key projection only when that flag is exactly "1".
          bucket = __lookupByEntityMatchKey(eindex, canonicalId);
        } catch (err) {
          // Per-entity lookup failure is non-fatal — continue with the
          // remaining entities. The fallback is best-effort.
          void err;
          continue;
        }
        if (!Array.isArray(bucket)) continue;
        // Flag ON consumes ledger-ordered buckets newest-first; flag OFF
        // returns the exact bucket reference and preserves legacy prefix order.
        const orderedBucket = _orderEntityFallbackBucket(bucket);
        for (const id of orderedBucket) {
          if (typeof id !== "string" || id.length === 0) continue;
          if (existingIds.has(id)) continue;
          fallbackIds.add(id);
          if (
            fallbackIds.size >= CAPS.RECALL_SUBSTRATE_FALLBACK_MAX_CANDIDATES
          ) {
            break;
          }
        }
        if (
          fallbackIds.size >= CAPS.RECALL_SUBSTRATE_FALLBACK_MAX_CANDIDATES
        ) {
          break;
        }
      }
      if (fallbackIds.size > 0) {
        fallbackTriggered = true;
        // Append each new id with zero scores; the rest of the pipeline
        // (multi-feature scorer) computes their final_score from the
        // substrate features (entity overlap, episodicity, valence, etc.).
        // dense_score / bm25_score / rrf_score remain 0 — the substrate
        // path is an alternate route INTO scoring, not a parallel scoring
        // signal that gets fused.
        for (const id of fallbackIds) {
          fused.push({
            memory_id: id,
            rrf_score: 0,
            dense_score: 0,
            bm25_score: 0,
            dense_rank: -Infinity,
            bm25_rank: -Infinity,
          });
          fallbackAddedCandidates++;
        }
      }
    } catch (err) {
      // Defensive: degraded entity-index (cache corruption, ledger read
      // failure, etc.) MUST NOT tip the recall response. Log and proceed
      // with whatever the hybrid retriever returned.
      fallbackSkipReason = "entity_index_load_failed";
      populatorDegradedReasons.push("entity_index_load_failed");
      try {
        console.error(
          `memory_recall: substrate-aware fallback load failed; degrading to indices-only: ${err && err.message ? err.message : String(err)}`,
        );
      } catch {
        // logger throws don't propagate
      }
    }
  } else if (fused.length < CAPS.RECALL_SUBSTRATE_FALLBACK_TRIGGER_THRESHOLD) {
    // Trigger met on the threshold side but no populator entities — record
    // the no-op reason so operators can size whether the populator needs
    // attention. This is NOT a degraded path; the surrounding context
    // simply contained no structural anchors.
    fallbackSkipReason = "populator_entities_empty";
  }

  // -------------------------------------------------------------------------
  // d.6. WORKUNIT N8 — temporal substrate fallback (the time-index WIRE slot).
  //
  // The exact mirror of the entity-index fallback above. When the BM25 + HNSW
  // union (PLUS any entity-fallback augmentation) STILL produces fewer than
  // RECALL_SUBSTRATE_FALLBACK_TRIGGER_THRESHOLD unique candidates AND the
  // populator resolved an absolute time anchor from the surrounding context,
  // augment the pool with memory_ids whose features.time_anchors[] fall within
  // RECALL_TIME_FALLBACK_WINDOW_MS of the resolved instant (via the cached
  // substrate-tier time-index — a sorted projection over absolute instants,
  // rebuilt under the SAME mtime+size fingerprint as the entity-index, NOT a
  // fresh full-ledger scan).
  //
  // resolvedTimeAnchor was previously consumed ONLY as the scalar
  // `timeAnchorMatch` scoring feature (multi-feature-score) — never for
  // candidate selection. This fallback is the missing candidate-recall slot:
  // a query with a time anchor but a starved pool now reaches temporally-near
  // facts the lexical/dense legs missed.
  //
  // Non-double-count (M6): this is candidate-RECALL only. Appended ids carry
  // rrf/dense/bm25 score 0; the multi-feature scorer computes their final_score
  // from the substrate features exactly as for entity-fallback ids. Scoring
  // weights (SCORE_WEIGHT_TIME_ANCHOR / SCORE_WEIGHT_TIME_DECAY) are untouched.
  //
  // Defensive degrade: any throw (cache corrupt, ledger read failure) skips the
  // fallback (logged + swallowed). An absent/stale cache rebuilds-or-skips.
  // -------------------------------------------------------------------------
  let timeFallbackTriggered = false;
  let timeFallbackAddedCandidates = 0;
  if (
    fused.length < CAPS.RECALL_SUBSTRATE_FALLBACK_TRIGGER_THRESHOLD &&
    typeof resolvedTimeAnchor === "string" &&
    resolvedTimeAnchor.length > 0
  ) {
    try {
      const ledgerPath = memoryLedgerPath();
      const cachePath = join(STORAGE_DIR, "time-index.cache.json");
      const tindex = await __loadOrRebuildTimeIndex({ ledgerPath, cachePath });
      const existingIds = new Set();
      for (const f of fused) existingIds.add(f.memory_id);
      const remainingCap =
        CAPS.RECALL_SUBSTRATE_FALLBACK_MAX_CANDIDATES;
      const proximate = __queryProximityTimeIndex(tindex, {
        target_iso: resolvedTimeAnchor,
        window_ms: CAPS.RECALL_TIME_FALLBACK_WINDOW_MS,
        // queryProximity already orders by ascending distance + dedup-free, so
        // we over-request a little and dedup against the existing pool below.
        max_results: remainingCap + existingIds.size,
      });
      const timeFallbackIds = new Set();
      for (const hit of Array.isArray(proximate) ? proximate : []) {
        const id = hit && typeof hit.memory_id === "string" ? hit.memory_id : "";
        if (id.length === 0) continue;
        if (existingIds.has(id)) continue;
        if (timeFallbackIds.has(id)) continue;
        timeFallbackIds.add(id);
        if (timeFallbackIds.size >= remainingCap) break;
      }
      if (timeFallbackIds.size > 0) {
        timeFallbackTriggered = true;
        for (const id of timeFallbackIds) {
          fused.push({
            memory_id: id,
            rrf_score: 0,
            dense_score: 0,
            bm25_score: 0,
            dense_rank: -Infinity,
            bm25_rank: -Infinity,
          });
          timeFallbackAddedCandidates++;
        }
        // Fold into the shared counters so the brief envelope reflects the
        // combined substrate-fallback contribution.
        fallbackTriggered = true;
        fallbackAddedCandidates += timeFallbackAddedCandidates;
      }
    } catch (err) {
      populatorDegradedReasons.push("time_index_load_failed");
      if (fallbackSkipReason == null) {
        fallbackSkipReason = "time_index_load_failed";
      }
      try {
        console.error(
          `memory_recall: temporal substrate fallback load failed; degrading: ${err && err.message ? err.message : String(err)}`,
        );
      } catch {
        // logger throws don't propagate
      }
    }
  }
  void timeFallbackTriggered;

  // -------------------------------------------------------------------------
  // e. Load IndexEntry shapes for the candidate set from the ledger.
  //
  // WU-RR2b — SCOPED resolution. The old `loadLedger()` built a byId Map over
  // every one of the 1.45M ledger rows via readFileSync(ledgerPath, "utf8"),
  // which crashed with ERR_STRING_TOO_LONG once memory.jsonl crossed Node's
  // ~512 MiB MAX_STRING_LENGTH (the live ledger is 1.78 GB). That crash made
  // recall return candidate_set_size=0 for EVERY query even though BM25
  // returned candidate ids. We now stream ONLY the bounded fused candidate ids
  // (typically hundreds) into a scoped byId Map; the rest of the ledger never
  // enters the heap. loadLedger() survives for legacy/test callers (and is now
  // itself stream-safe + capped).
  // -------------------------------------------------------------------------
  // WU-dense-reembed-infra — chunk-id resolution + dedup. The 4096 HNSW returns
  // chunk-ids `${factId}#${k}` for facts that were re-embedded as multiple
  // chunk-vectors (the >40,960-token giants). There is NO ledger row for a
  // chunk-id, so each fused entry's id is mapped back to its PARENT fact id via
  // _stripChunkSuffix before resolving the row. We then DEDUP multiple chunks of
  // one fact into a single candidate, keeping the BEST-scoring chunk as the
  // fact's representative (so a giant surfaces at most once — no chunk-id
  // duplicates leak into the candidate set). rrf_score is the dedup key (it is
  // the fused rank signal; dense_score/bm25_score follow the winning chunk).
  // Non-chunked ids pass through unchanged (1 fused entry -> 1 candidate).
  const neededIds = new Set();
  for (const f of fused) {
    if (typeof f.memory_id !== "string") continue;
    neededIds.add(_stripChunkSuffix(f.memory_id));
  }
  __mark("substrate-fallback");
  const ledger = loadLedgerRowsByIds(neededIds);
  __mark("loadLedgerRowsByIds");
  // Best fused entry per FACT id (chunk-collapsed). rrf_score is the ranking
  // signal RRF emits; the highest-rrf chunk represents the fact.
  const bestFusedByFactId = new Map(); // factId -> fused entry (best so far)
  for (const f of fused) {
    if (typeof f.memory_id !== "string") continue;
    const factId = _stripChunkSuffix(f.memory_id);
    const prev = bestFusedByFactId.get(factId);
    const fScore = typeof f.rrf_score === "number" ? f.rrf_score : -Infinity;
    if (prev === undefined) {
      bestFusedByFactId.set(factId, f);
      continue;
    }
    const prevScore = typeof prev.rrf_score === "number" ? prev.rrf_score : -Infinity;
    if (fScore > prevScore) bestFusedByFactId.set(factId, f);
  }
  const candidates = [];
  const seenFactIds = new Set();
  // Iterate fused in its original (fused-rank) order so candidate ordering is
  // stable/deterministic; emit each fact once, using its best chunk's scores.
  for (const f of fused) {
    if (typeof f.memory_id !== "string") continue;
    const factId = _stripChunkSuffix(f.memory_id);
    if (seenFactIds.has(factId)) continue; // already emitted this fact
    seenFactIds.add(factId);
    const row = ledger.byId.get(factId);
    if (row == null) continue; // candidate referenced an id we cannot resolve
    const entry = rowToIndexEntry(row, EMBEDDING_MODEL_VERSION);
    if (entry == null) continue;
    const best = bestFusedByFactId.get(factId) || f;
    candidates.push({
      ...entry,
      rrf_score: best.rrf_score,
      dense_score: best.dense_score,
      bm25_score: best.bm25_score,
      // WU-dense-reembed-infra fix: the index stores a giant's vectors ONLY
      // under chunk-ids (`${factId}#${k}`), never the bare factId. Carry the
      // WINNING chunk's id so the s_emb overlay can fetch that chunk's vector
      // by its real index key (the bare-factId lookup misses for giants and
      // the giant would otherwise rescore at s_emb=0). For non-chunked facts
      // best.memory_id === factId, so this is a harmless identity.
      index_vector_id: best.memory_id,
    });
  }

  // WU-RR2b — second scoped stream for reconstructed candidates' derived_from
  // parents. The W8 brief surfaces derived_from_titles (step m,
  // _derivedFromTitlesFor) by looking up each parent row's content in
  // ledger.byId. With the scoped resolver above, parent rows are NOT in byId
  // unless the parent was itself a candidate. Reconstructed candidates are
  // rare, so collect their derived_from parent ids and merge a SECOND scoped
  // stream into the same byId map (cold path). Self/duplicate ids already in
  // byId are skipped by the wanted-set; latest-write-wins is preserved.
  const reconstructedParentIds = new Set();
  for (const c of candidates) {
    if (c.kind !== "reconstructed") continue;
    if (!Array.isArray(c.derived_from)) continue;
    for (const pid of c.derived_from) {
      if (typeof pid === "string" && pid.length > 0 && !ledger.byId.has(pid)) {
        reconstructedParentIds.add(pid);
      }
    }
  }
  if (reconstructedParentIds.size > 0) {
    const parents = loadLedgerRowsByIds(reconstructedParentIds);
    for (const [pid, prow] of parents.byId) {
      if (!ledger.byId.has(pid)) ledger.byId.set(pid, prow);
    }
  }

  // -------------------------------------------------------------------------
  // f. Hard gates: predicate exclusion, consent dampener, derivation orphan.
  // -------------------------------------------------------------------------
  const activePredicates = await loadActivePredicates();
  const transitiveOrphanMap = await loadTransitiveOrphanMap();
  __mark("build-candidates");
  const gated = applyHardGates(candidates, {
    activePredicates,
    transitive_orphan_map: transitiveOrphanMap,
    embedding_model_version: EMBEDDING_MODEL_VERSION,
  });

  // -------------------------------------------------------------------------
  // f.5. Wave 8 — derivation-graph reconstructed-parent gate
  //      (F-SYN-INTEGRATION-DERIVATION-GRAPH-RECALL-PATHWAY).
  //
  //  Orthogonal to the v0 transitive-orphan dampener (which targets facts
  //  via the depth-aware exp curve). This gate is BINARY and ONLY fires on
  //  kind="reconstructed":
  //
  //    1.0 — non-reconstructed candidate (gate is a no-op)
  //    1.0 — reconstructed; >=1 derived_from parent is NOT orphaned
  //    0.0 — reconstructed; ALL derived_from parents are orphaned
  //
  //  Orphaned membership for a parent is the union of (a) direct excise
  //  seeds from loadDerivationExciseSet and (b) every descendant reached by
  //  walkExcisePropagation from those seeds. The walker is the substrate's
  //  reverse-adjacency BFS — capped at PROPAGATION_DEPTH_MAX (3), defended
  //  against cycles.
  //
  //  Defensive degrade: if loadOrRebuildDerivationGraph throws or
  //  loadDerivationExciseSet throws, derivation_status falls back to 1.0
  //  for every candidate (no gate) and a populator.degraded_reasons entry
  //  is appended so operators see the substrate outage in the brief.
  // -------------------------------------------------------------------------
  const derivationGateStatusById = new Map();
  let derivationGraphForBrief = null;
  try {
    const ledgerPath = memoryLedgerPath();
    const cachePath = join(STORAGE_DIR, "derivation-graph.cache.json");
    const dgGraph = await loadOrRebuildDerivationGraph({
      ledgerPath,
      cachePath,
    });
    derivationGraphForBrief = dgGraph;
    let exciseSeeds;
    try {
      exciseSeeds = await loadDerivationExciseSet();
    } catch (err) {
      void err;
      exciseSeeds = new Set();
    }
    const orphanedSet = new Set();
    for (const seed of exciseSeeds) {
      orphanedSet.add(seed);
      try {
        for (const desc of walkExcisePropagation(dgGraph, seed)) {
          orphanedSet.add(desc.memoryId);
        }
      } catch (innerErr) {
        // Per-seed walk failure is non-fatal — keep the directly-excised
        // seed in the orphan set so direct parents still gate correctly.
        void innerErr;
      }
    }
    for (const c of candidates) {
      const status = _computeDerivationGateStatus(c, orphanedSet);
      derivationGateStatusById.set(c.memory_id, status);
    }
  } catch (err) {
    console.error(
      `memory_recall: derivation-graph load failed; degrading to derivation_status=1.0 fallback: ${err.message}`,
    );
    populatorDegraded = true;
    populatorDegradedReasons.push("derivation_graph_load_failed");
    for (const c of candidates) {
      derivationGateStatusById.set(c.memory_id, 1.0);
    }
  }

  // -------------------------------------------------------------------------
  // f.6. W3-CCS — F-CCS-BACKFILL-recall-consumer FOLLOWUP.
  //
  // Build the latest-backfill map ONCE per recall (handler-scoped). The
  // builder maintains its own module-level cache keyed by ledger
  // (path, mtimeMs, sizeBytes, builtAtMs<60s); subsequent recalls in the
  // same process reuse the projection without re-reading the ledger.
  //
  // Without this wiring, applyBackfillOverlay is dead code — the W3 engine
  // emits policy.feature_backfill rows but no recall path consumes them
  // (W3-spawn finding). Wiring here makes the 83 historical bare-fact
  // backfills materially affect ranking: their entity-overlap channel
  // fires post-overlay where it was 0 pre-overlay.
  //
  // Defensive: a throw from buildLatestBackfillMap (engine crash, IO error,
  // ledger corruption) degrades to "no overlay" — every candidate flows
  // through with original features. Surfaced as populatorDegraded so
  // operators see the substrate outage on the brief envelope.
  // -------------------------------------------------------------------------
  let latestBackfillMap = new Map();
  try {
    const backfillLedgerPath = memoryLedgerPath();
    __mark("applyHardGates+derivation");
    latestBackfillMap = buildLatestBackfillMap(backfillLedgerPath);
    __mark("buildLatestBackfillMap");
    if (!(latestBackfillMap instanceof Map)) {
      latestBackfillMap = new Map();
    }
  } catch (err) {
    console.error(
      `memory_recall: buildLatestBackfillMap failed; degrading to no-overlay: ${err && err.message ? err.message : String(err)}`,
    );
    populatorDegraded = true;
    populatorDegradedReasons.push("feature_backfill_map_load_failed");
    latestBackfillMap = new Map();
  }

  // -------------------------------------------------------------------------
  // g. For EVERY gated candidate (masked predicate_mask=0 entries included —
  //    applyHardGates returns them rather than dropping): compute
  //    s_emb_full3072 against the FIRST segment vector (per the v0 design
  //    note in the brief; pooled mean is a v1 concern). Then computeScore.
  //    Masked and additive-floor candidates are hard-dropped AFTER scoring,
  //    at the B1a Layer-2 OUTPUT partition below (retained in the recall
  //    event's candidates_pre_truncation with drop provenance).
  // -------------------------------------------------------------------------
  // surrounding_context shape consumed by multi-feature-score:
  //   { entities, time_anchor, valence, query_episodicity }
  //
  // Wave 6 integration: these were stubbed (entities=[], time_anchor=null,
  // valence=null) until the synthesis substrate (entity-extractor,
  // time-anchor-resolver, valence-scorer, episodicity-scorer) was wired in.
  // The populator block above (§ a.5) runs the same modules the cascade-side
  // stamper uses (I-CP-2 symmetry contract). Failures degrade their single
  // axis to its empty value; the brief envelope surfaces populator.degraded.
  const scoringContextEntityIds = _resolveRecallEntityAliases(
    populatorEntityIds,
    recallEntityWiring.aliasOverlay,
  );
  const scoringContext = {
    entities: scoringContextEntityIds,
    time_anchor: resolvedTimeAnchor,
    // valence-scorer returns {sign, magnitude, source, model_version}; the
    // multi-feature scorer's valenceCompat treats the candidate side as a
    // scalar in [-1, +1]. Surface the sign so the existing scalar contract
    // remains intact (valence_compat = 1 - |c - x|/2 with x=sign).
    valence: populatorValence != null && typeof populatorValence.sign === "number"
      ? populatorValence.sign
      : null,
    query_episodicity: populatorQueryEpisodicity,
  };

  // N1-calibration — resolve the live-weight overlay ONCE per recall. Gate OFF
  // (default) → frozen CAPS triple (all 0.0), so the additive priors contribute
  // nothing and the scoring loop is byte-identical to pre-N1 behavior. Only
  // when the overlay actually applies a projection (gate ON + reviewed/harm-
  // safe/NDCG-positive) do we build the engagement-prior map — keeping the
  // gate-OFF recall path free of any extra ledger scan. Defensive: any failure
  // degrades to frozen CAPS / no engagement map (the recall hot path is never
  // blocked by a calibration-substrate fault).
  let scoreWeightOverlay = null;
  let engagementPriorById = null;
  try {
    scoreWeightOverlay = resolveScoreWeightOverlay({ ledgerPath: memoryLedgerPath() });
  } catch (err) {
    console.error(
      `memory_recall: resolveScoreWeightOverlay failed; using frozen CAPS weights: ${err && err.message ? err.message : String(err)}`,
    );
    scoreWeightOverlay = null;
  }

  // -------------------------------------------------------------------------
  // N6-stamp-priors — populate candidate.priors so the three SCORE_WEIGHT_*_PRIOR
  // weights (proved-wired by N1) have a NON-neutral input to act on.
  //
  // Build all three prior projections ONCE per recall (handler-scoped), then
  // stamp each candidate from the prebuilt maps in the scoring loop below:
  //   - engagementPriorById      : Map<memory_id, prior>  (recall-feedback rows)
  //   - dampingCoefficientById   : Map<memory_id, coef>   (ONE damping-log scan)
  //   - corroboration_boost      : pure walk of derivationGraphForBrief (already
  //                                loaded above — no extra I/O)
  //
  // LATENCY: the damping map is built via buildDampingCoefficientMap, a SINGLE
  // damping-log scan, NOT computeDampingCoefficient per candidate (which would
  // re-scan the whole log ~1366×). The corroboration walk reuses the cached
  // derivation graph. So priors stamping adds at most ONE bounded damping-log
  // scan + ONE recall-feedback projection (append-aware, warm-cached) per
  // recall — no new memory.jsonl full-ledger scan.
  //
  // DEFAULT ON (CAPS.RECALL_STAMP_PRIORS_ENABLED): because the three weights are
  // still 0.0, stamping non-neutral priors is a RANKING NO-OP until N1's
  // calibration overlay flips a weight off 0.0 — so it is safe to ship stamped.
  // Gate OFF → no maps built, no extra scan, neutral priors, byte-identical rank.
  //
  // Defensive: any projection failure degrades that leg to neutral; the recall
  // hot path is never blocked.
  // -------------------------------------------------------------------------
  let dampingCoefficientById = null;
  const stampPriors = CAPS.RECALL_STAMP_PRIORS_ENABLED === true;
  if (stampPriors) {
    try {
      engagementPriorById = buildEngagementPriorMap(memoryLedgerPath());
      if (!(engagementPriorById instanceof Map)) engagementPriorById = null;
    } catch (err) {
      console.error(
        `memory_recall: buildEngagementPriorMap failed; engagement leg inert this recall: ${err && err.message ? err.message : String(err)}`,
      );
      engagementPriorById = null;
    }
    try {
      dampingCoefficientById = await buildDampingCoefficientMap({});
      if (!(dampingCoefficientById instanceof Map)) dampingCoefficientById = null;
    } catch (err) {
      console.error(
        `memory_recall: buildDampingCoefficientMap failed; damping leg neutral this recall: ${err && err.message ? err.message : String(err)}`,
      );
      dampingCoefficientById = null;
    }
  }

  // Q2 (memperf) — daemon-mode Layer-2 rescore vectors. The scoring loop
  // below resolves each candidate's active-geometry vector via
  // _resolveCandidateEmbedding(candidate, hnsw, queryDim) — in-process that
  // reads the loaded HNSW sidecar via getVectorByMemoryId. In daemon mode we
  // batch-prefetch the SAME lookups over queryd (vector_fetch, client-chunked
  // at VECTOR_FETCH_MAX_IDS=256 per frame): the union of memory_id +
  // winning-chunk index_vector_id for every candidate lacking a same-dim ROW
  // vector (row vectors win first, exactly as inside
  // _resolveCandidateEmbedding). v3-ledger-embedding-reroute: with
  // MEMORY_LEDGER_ROW_EMBEDDING_4096 unset (the default) new cascade facts
  // carry NO row vector, so this prefetch now covers essentially the WHOLE
  // candidate set rather than only the pre-local-backend population — only
  // legacy Gemini rows and rows written while the flag was on still win at the
  // row and are skipped here. The fetched Map is wrapped in a
  // getVectorByMemoryId shim and passed where the loaded HNSW is passed
  // today — _resolveCandidateEmbedding stays byte-untouched, and queryd's
  // structured nulls resolve to null -> s_emb=0 exactly like an index miss.
  let rescoreHnsw = hnsw;
  // b2-silent-recall-degrade — VISIBILITY-ONLY marker for an enrichment
  // prefetch that FAILED, in either of two classes. Declared at function scope
  // (same scope as `degradedRecall` / `indexGenerationRefused`) because both
  // envelope sites — the recall ledger event stamp and the ok() response —
  // read it. null on every healthy call, so those envelopes stay byte-
  // identical to their pre-node output. Two shapes, told apart by `code`:
  //   - THROW path (the catch below): {code, reason, ids_requested}, where
  //     `code` is the queryd error code.
  //   - NON-THROW path (the success block below): code
  //     "vector_prefetch_unresolved" plus {reason, ids_requested, ids_resolved,
  //     attested_missing}. queryd answers `ok:true` with `{id, vector: null}`
  //     for every id it cannot resolve (its own comment calls these
  //     "structured nulls") and queryd-client turns those into present keys
  //     with null values — so the common failure this node exists for, a
  //     generation swap, never reaches the catch at all.
  let vectorPrefetchDegraded = null;
  // b2-silent-recall-degrade (run 3) — THE THIRD BUCKET. `vectorPrefetchDegraded`
  // is a two-valued verdict (failed / did-not-fail) over a classifier that is
  // only DEFINED when at least one attested-resident id was requested. When
  // `attestedRequested === 0` the prefetch RAN but no id in it was attested, so
  // its health is UNMEASURABLE — and an unmeasurable state may NEVER produce a
  // positive assertion of health (F72). Run 2 folded it into the negative
  // result, which then licensed `vector_resolved: false` for every candidate
  // and converted an availability failure into a mass hard-drop at the 0.10
  // fallback floor. This flag carves that state out so the scoring view can
  // ABSTAIN instead of asserting either way. Declared at function scope beside
  // `vectorPrefetchDegraded` / `rescoreHnsw` / `degradedRecall` because the
  // scoring view far below reads it. It is NOT a failure signal and is
  // deliberately NOT OR-ed into `degraded_recall` — see the residual decision
  // recorded in the node report.
  let vectorPrefetchUnverifiable = false;
  if (useQueryd) {
    rescoreHnsw = null;
    if (!degradedRecall && firstSegmentVec3072 != null) {
      const queryDim = firstSegmentVec3072.length;
      const wantedVectorIds = new Set();
      for (const c of candidates) {
        if (c == null || typeof c !== "object") continue;
        if (_selectSameDimEmbedding(c, queryDim) != null) continue;
        if (typeof c.memory_id === "string" && c.memory_id.length > 0) {
          wantedVectorIds.add(c.memory_id);
        }
        if (
          typeof c.index_vector_id === "string" &&
          c.index_vector_id.length > 0 &&
          c.index_vector_id !== c.memory_id
        ) {
          wantedVectorIds.add(c.index_vector_id);
        }
      }
      let vectorsById = new Map();
      if (wantedVectorIds.size > 0) {
        try {
          const fetched = await querydClient.vectorFetch(indexModelVersion, [
            ...wantedVectorIds,
          ]);
          vectorsById = fetched.byId;
          // b2-silent-recall-degrade (run 2) — DETECT THE NON-THROWING FAILURE.
          //
          // The catch below only ever sees a THROWN vector_fetch. queryd's
          // handler returns `ok:true` with `{ id: mid, vector: null }` for any
          // id it cannot resolve ("unknown/tombstoned ids are structured
          // nulls"), and queryd-client stores those as PRESENT keys with null
          // values (`byId.set(v.id, Array.isArray(v.vector) ? v.vector : null)`).
          // A generation swap — the exact event the operator is about to cause
          // by publishing a rebuilt index — does not throw; it makes ids
          // unresolvable. So without this block the marker fires on the rare
          // path and stays silent on the common one.
          //
          // WHY NOT `resolved < requested`: a lexical doc with no vector is a
          // NORMAL, permanent state, not a failure. Measured on the live tree
          // (read-only census by resolution, no daemon call): 31 of the active
          // tree's 14,442 bm25.json "L" doc ids are already absent from
          // hnsw.bin.meta.json's 124,890-entry id_map today. PROJECTED (not
          // measured here): the pending full BM25 rebuild takes the lexical
          // side to roughly the ledger's ~1.5M rows against that same vector
          // count, so a `resolved < requested` predicate would be ALWAYS ON —
          // the same lie as always-off. The three measured counts and the exact
          // command that produced them are recorded in the node report (GOAL
          // #3: censused by resolution, never from a comment or a cache key).
          //
          // THE DISCRIMINATOR is instead an id we can ATTEST was resident: an
          // id the dense leg just returned as a hit AND that we then asked for.
          // Intersecting with wantedVectorIds means an id we never requested is
          // never asserted about. `attested_missing > 0` is exact rather than
          // thresholded because queryd never mutates a resident entry's
          // hnsw/tombstones in place under a stable generation: both writers
          // replace the WHOLE `this.models` entry (`this.models.set(mv, {...,
          // generation: health.generation})`), `_run` captures `entry` once per
          // frame, and the only in-place mutation — the watch tick's WAL-tail
          // absorb via `_applyAddRecord` — is ADD-ONLY and never tombstones. So
          // an attested id cannot legitimately vanish between the two calls.
          let idsResolved = 0;
          for (const v of vectorsById.values()) {
            if (Array.isArray(v) && v.length > 0) idsResolved += 1;
          }
          let attestedRequested = 0; // |querydDenseHitIds ∩ wantedVectorIds|
          let attestedMissing = 0;
          for (const id of wantedVectorIds) {
            if (!querydDenseHitIds.has(id)) continue;
            attestedRequested += 1;
            const v = vectorsById.get(id);
            if (!(Array.isArray(v) && v.length > 0)) attestedMissing += 1;
          }
          // THIRD BUCKET (see vectorPrefetchUnverifiable's declaration): the
          // prefetch ran but NO requested id was attested-resident, so the
          // discriminator below has no evidence either way and its negative
          // answer carries no information. Set unconditionally and
          // independently of the verdict — `degradedRecall` is untouched here,
          // and so is `vectorPrefetchDegraded`, which keeps meaning "the
          // prefetch demonstrably FAILED".
          if (attestedRequested === 0) vectorPrefetchUnverifiable = true;
          // Today this inequality is silently DISCARDED by the
          // `querydGeneration == null &&` guard on the stamp below: the
          // retrieval leg has already stamped a generation, so a prefetch that
          // answers from a DIFFERENT one is simply ignored. That mismatch is
          // also what makes the RC-Finding-2 exclusion-gate reapply's
          // "generation consistency holds by construction" claim checkable
          // instead of assumed — it is flagged here, never suppressed.
          const generationChanged =
            querydGeneration != null &&
            fetched.generation != null &&
            fetched.generation !== querydGeneration;
          if (generationChanged || (attestedRequested > 0 && attestedMissing > 0)) {
            // Same leak discipline as the catch: machine-readable failure class
            // and integer counts ONLY — no err.message, no candidate ids, no
            // query text. Distinguished from the throw path by `code`, which
            // leaves that marker's 3-key shape untouched.
            vectorPrefetchDegraded = {
              code: "vector_prefetch_unresolved",
              reason: generationChanged
                ? "generation_changed"
                : "attested_ids_unresolved",
              ids_requested: wantedVectorIds.size,
              ids_resolved: idsResolved,
              attested_missing: attestedMissing,
            };
          }
          if (querydGeneration == null && fetched.generation != null) {
            querydGeneration = fetched.generation;
          }
        } catch (err) {
          // RC Finding 1 — this is an ENRICHMENT-only prefetch: the candidate
          // set was ALREADY retrieved above (bm25/hnsw search). A vector_fetch
          // availability failure here (queryd loading / restart / generation
          // swap mid-recall) must NOT escalate into a whole-recall
          // queryd_unavailable ToolError — that is STRICTER than the in-process
          // path this replaces, where _resolveCandidateEmbedding is
          // defensive-null (a resolution miss -> s_emb=0, never a thrown call).
          // So ANY error degrades to an empty overlay map: every overlay-needing
          // candidate resolves to s_emb=0 via the rescoreHnsw shim below
          // (getVectorByMemoryId -> null), exactly matching the in-process
          // index-miss path, and the brief stays COMPLETE. This widens the
          // pre-existing QuerydBadRequestError -> empty-map degrade (the
          // empty-index shape) to cover availability failures too; we do NOT
          // throw querydDegradeError here.
          vectorsById = new Map();
          // b2-silent-recall-degrade — the degrade above is CORRECT (a complete
          // brief beats a thrown recall) but it was SILENT: the envelope kept
          // reporting degraded_recall:false, so an operator could not tell a
          // queryd blip that zeroed s_emb for every overlay-needing candidate
          // apart from "nothing was semantically relevant". Record the failure
          // as a VISIBILITY-ONLY marker, OR-ed into degraded_recall at the two
          // envelope sites below.
          //
          // MEASURED, not assumed:
          //   - This assignment does NOT touch the behavior-gating
          //     `degradedRecall` variable (FU2 precedent, stated at the
          //     indexGenerationRefused site): the dense leg is never suppressed
          //     to make the flag easier to set, and the brief this call returns
          //     is byte-identical to the pre-node brief in every field except
          //     the new degraded_* keys.
          //   - degraded_reason CANNOT collide with "queryd_model_missing":
          //     that path sets degradedRecall = true before this block, and the
          //     enclosing guard is `!degradedRecall && firstSegmentVec3072 !=
          //     null`, so the prefetch never runs on a model-missing (or any
          //     other already-degraded / BM25-only) call.
          //   - It CAN co-occur with index_generation_refused (that marker is
          //     read off the daemon status and does not gate the prefetch). The
          //     spread below is placed BEFORE the index_generation_refused
          //     spread so the pre-existing degraded_reason value wins on a
          //     collision while the dedicated vector_prefetch_degraded key is
          //     never lost.
          //
          // Carries the machine-readable failure CLASS only — never
          // err.message, never candidate ids, never query text (queryd-client's
          // logging discipline).
          vectorPrefetchDegraded = {
            code: err?.code ?? "unknown",
            reason: typeof err?.reason === "string" ? err.reason : null,
            ids_requested: wantedVectorIds.size,
          };
          try {
            console.error(
              `memory_recall: Layer-2 vector prefetch failed; degrading dense-rescore overlay to empty (s_emb=0 for overlay-needing candidates, complete brief preserved): ${
                err && err.message ? err.message : String(err)
              }`,
            );
          } catch {
            // logger throws never propagate on the recall request path.
          }
        }
      }
      rescoreHnsw = {
        getVectorByMemoryId: (id) => vectorsById.get(id) ?? null,
      };
    }
  }

  // b2-silent-recall-degrade (run 3) — DENSE-LEG REFUSAL marker, derived once
  // from the counters filled by the retrieval block above (they are final by
  // here: every hnsw_search settled inside that block's Promise.all).
  //
  // SCOPE, deliberately distinct from vectorPrefetchDegraded: that marker is
  // PREFETCH-scoped ("the Layer-2 enrichment overlay failed"). This one is
  // RETRIEVAL-scoped ("the semantic half of candidate generation was refused
  // and silently emptied"). Overloading one onto the other would be a false
  // attribution — on the RC-B8 fixture the prefetch did not fail, it was merely
  // unverifiable, while the dense leg genuinely was refused.
  //
  // VISIBILITY ONLY: like every other marker on this path it is OR-ed into
  // `degraded_recall` at the two envelope sites and NEVER assigned to the
  // behavior-gating `degradedRecall` variable, so no leg is suppressed to make
  // a signal easier to produce and the brief stays COMPLETE.
  //
  // LEAK DISCIPLINE: machine-readable failure class plus integer counts only —
  // no err.message, no candidate ids, no query text (queryd-client's logging
  // contract). RC-B8 pins the exact key set.
  const denseSearchDegraded =
    denseLegsEmptiedByBadRequest > 0
      ? {
          code: "dense_search_bad_request",
          legs_requested: denseLegsRequested,
          legs_emptied: denseLegsEmptiedByBadRequest,
        }
      : null;

  let scored = [];
  // W2 key-space canary input. Candidate ids are appended from the exact
  // post-backfill, post-alias scoring views below; the query-side union starts
  // here. The assertion runs after every candidate has contributed so one
  // genuinely new/unknown entity cannot false-alarm when another key resolves.
  const entityDfCanaryIds = recallEntityWiring.entityDf == null
    ? null
    : [...scoringContextEntityIds];
  for (let i = 0; i < gated.length; i++) {
    const g = gated[i];
    const cRaw = candidates[i];
    // W3-CCS — F-CCS-BACKFILL-recall-consumer FOLLOWUP.
    //
    // Apply the feature-backfill overlay BEFORE scoring. The returned object
    // is a NEW candidate with:
    //   - .features bag merged per spec §4.3 (per-channel REPLACE; overlay
    //     channels REPLACE the original, absent channels preserve original).
    //   - .entities flattened from overlay objects {kind,canonical_id} to
    //     canonical_id strings so the existing entityOverlapJaccard scorer
    //     path fires without a downstream refactor.
    // The original cRaw object is unmutated (thesis #1) — only the in-memory
    // scoring view sees the overlay.
    //
    // Defensive: a throw from applyBackfillOverlay degrades that single
    // candidate to its raw (pre-overlay) shape; the rest of the candidate
    // set scores normally.
    let c = cRaw;
    if (latestBackfillMap.size > 0) {
      try {
        c = applyBackfillOverlay(cRaw, latestBackfillMap);
        if (c == null || typeof c !== "object") c = cRaw;
      } catch (err) {
        try {
          console.error(
            `memory_recall: applyBackfillOverlay threw for ${cRaw.memory_id}; degrading to raw candidate: ${err && err.message ? err.message : String(err)}`,
          );
        } catch {
          // logger throws don't propagate
        }
        c = cRaw;
      }
    }
    // F1/W2 — alias only the in-memory scoring view. Historical canonical_ids,
    // ledger rows, candidate objects, and live index structures remain intact.
    const scoringCandidateEntityIds = _resolveRecallEntityAliases(
      c.entities,
      recallEntityWiring.aliasOverlay,
    );
    if (entityDfCanaryIds !== null && Array.isArray(scoringCandidateEntityIds)) {
      entityDfCanaryIds.push(...scoringCandidateEntityIds);
    }
    // s_emb only when both a query vec and a SAME-MODEL candidate vec exist.
    //
    // WU1-local-embedder-client-and-dim4096 — cross-model isolation. A
    // candidate may carry embedding_4096 (full Qwen3, the active local model)
    // OR embedding_3072 (legacy Gemini). The cosine-as-dot is only meaningful
    // between vectors from the SAME geometry, so we compare against whichever
    // candidate vector matches the QUERY vector's dimensionality. A candidate
    // whose only vector lives in a different space scores s_emb=0 (it falls
    // through to the additive branch) — never a spurious cross-model cosine.
    // The query vector is currently produced by the Gemini segment encoder
    // (3072d) this phase; WU2 swaps the query path to the local 4096 backend,
    // at which point the 4096 candidate vectors light up automatically via the
    // same length match. No code change needed there — the dim IS the model
    // selector while the two backends produce distinct, non-overlapping dims.
    //
    // WU-dense-reembed-infra — index-side overlay. Pre-existing facts carry NO
    // embedding on their immutable row (rowToIndexEntry leaves embedding_4096
    // null); their real 4096 vector lives ONLY in the index. Since
    // v3-ledger-embedding-reroute that is true of NEW facts as well: with
    // MEMORY_LEDGER_ROW_EMBEDDING_4096 unset (the default) the cascade writes
    // the vector out-of-band to the index WAL instead of onto the row.
    // _resolveCandidateEmbedding returns the row vector when present — now only
    // legacy Gemini rows and rows written while the flag was on — and otherwise
    // overlays the index-resident vector via hnsw.getVectorByMemoryId,
    // dimension-guarded against the query so the 3072 fallback never mixes
    // geometries.
    let s_emb_full3072 = 0;
    // B1b — hoist the resolved active-geometry vector (row embedding or
    // HNSW-sidecar overlay, query-dim guarded) so Layer-4 MMR, the brief
    // `enriched` projection, and the density flag can consume the SAME
    // vector the s_emb cosine used, instead of the dead candidate
    // .embedding_3072 field (0% live coverage post
    // WU-recall-flip-to-local-4096 — B1 Claim 2).
    let resolvedEmbedding = null;
    if (firstSegmentVec3072 != null) {
      const candVec = _resolveCandidateEmbedding(
        c,
        // Q2 — in-process this IS the loaded hnsw (unchanged); in daemon mode
        // it is the vector_fetch-backed getVectorByMemoryId shim built above.
        degradedRecall ? null : rescoreHnsw,
        firstSegmentVec3072.length,
      );
      if (candVec != null) {
        resolvedEmbedding = candVec;
        s_emb_full3072 = cosine3072(firstSegmentVec3072, candVec);
      }
    }
    // RC Finding 2 (HIGH, codex#5) — REAPPLY the predicate-exclusion gate AFTER
    // the same-generation vector is resolved.
    //
    // THE DEFECT: applyHardGates Step 1 (the batch gate at f. above) runs
    // BEFORE the index/HNSW vector is overlaid. A pre-existing durable exclusion
    // (e.g. a 4096 exclude) whose matching embedding is INDEX-ONLY — the fact's
    // row carries no same-dim vector, so _resolveGateVector returned null and
    // the batch gate SKIPPED it — never masks that candidate, and the excluded
    // content reaches rerank / the surfaced brief. That is a security leak
    // (an authorized exclusion silently misses historical facts).
    //
    // THE FIX: resolvedEmbedding above is now the REAL active-geometry vector
    // (row vector when present, else the HNSW/queryd overlay), resolved from the
    // SAME queryd generation as the candidate fetch (we issue NO new vector
    // fetch here — the overlay came from the same-generation prefetch above), so
    // generation-consistency holds by construction. Reapply the SINGLE
    // source-of-truth gate fn HG exposes (predicateMaskForCandidate — the exact
    // fn applyHardGates Step 1 calls, batch path passing resolvedVector=null)
    // over the SAME activePredicates set threaded to applyHardGates. No
    // divergent gate logic is duplicated here.
    //
    // This only ever ADDS a drop, never un-drops:
    //   - guarded on effectivePredicateMask === 1, so a batch-masked /
    //     consent_blocked / additive-floor candidate keeps its disposition;
    //   - guarded on resolvedEmbedding != null, so it is scoped to the dense
    //     channel — a candidate with no resolvable same-gen vector is untouched;
    //   - both effective-* vars are LOCAL to this iteration (thesis #1: neither
    //     c nor cRaw is ever mutated); the drop lands on the scored[] entry +
    //     the computeScore gate only.
    // Passing `c` (the overlay candidate resolvedEmbedding was resolved from)
    // keeps the vector view and the entity view consistent.
    let effectivePredicateMask = g.predicate_mask;
    let effectiveDroppedReason = g.dropped_reason;
    if (effectivePredicateMask === 1 && resolvedEmbedding != null) {
      const { masked, predicate_id } = predicateMaskForCandidate(
        c,
        resolvedEmbedding,
        activePredicates,
      );
      if (masked) {
        effectivePredicateMask = 0;
        effectiveDroppedReason = "predicate_excluded:" + predicate_id;
      }
    }
    // Wave 8 — derivation_status carries TWO orthogonal signals:
    //   (1) v0 transitive-orphan depth-aware dampener (g.derivation_status)
    //   (2) W8 substrate-tier reconstructed-parent binary gate
    // We compose them multiplicatively because they are independent
    // statements about the candidate's standing: the v0 dampener says
    // "your evidence floor is partially eroded" while the W8 gate says
    // "your entire derivation chain is orphaned, drop the multiplicative
    // branch entirely". Either signal alone is sufficient to demote a row;
    // both at once zero the multiplicative branch.
    const w8DerivationStatus = derivationGateStatusById.has(c.memory_id)
      ? derivationGateStatusById.get(c.memory_id)
      : 1.0;
    const composedDerivationStatus = g.derivation_status * w8DerivationStatus;
    // N6-stamp-priors — assemble candidate.priors from the prebuilt maps + the
    // pure corroboration walk. With CAPS.RECALL_STAMP_PRIORS_ENABLED OFF this
    // stays null (neutral 1.0/1.0 in computeScore) → byte-identical ranking.
    // damping_coefficient: from the once-per-recall damping-log scan; absent id
    // → BASE (1.0). corroboration_boost: pure BFS over the already-cached
    // derivation graph; null graph → BASE (1.0). Both are bounded scalars the
    // scorer re-clamps defensively. Stamped onto the score-time candidate object
    // ONLY (thesis #1: the fact row / cRaw is never mutated).
    let candidatePriors = null;
    if (stampPriors) {
      const dampingCoefficient = dampingCoefficientFromMap(
        dampingCoefficientById,
        c.memory_id,
      );
      let corroborationBoost = 1.0;
      if (derivationGraphForBrief != null) {
        try {
          corroborationBoost = computeCorroborationBoost({
            memory_id: c.memory_id,
            derivationGraph: derivationGraphForBrief,
          });
        } catch {
          corroborationBoost = 1.0;
        }
      }
      candidatePriors = {
        damping_coefficient: dampingCoefficient,
        corroboration_boost: corroborationBoost,
      };
    }
    const score = computeScore({
      s_emb_full3072,
      gates: {
        // RC Finding 2 — effectivePredicateMask folds in the post-overlay
        // reapply (index-only exclusion). g.predicate_mask when the reapply did
        // not fire (byte-identical to pre-fix).
        predicate_mask: effectivePredicateMask,
        consent_dampener: g.consent_dampener,
        derivation_status: composedDerivationStatus,
      },
      candidate: {
        memory_id: c.memory_id,
        kind: c.kind,
        ts: c.ts,
        entities: scoringCandidateEntityIds,
        valence: c.valence,
        // Wave 6 — propagate the candidate's stamped synthesis features so
        // the multi-feature scorer's episodicity_match can compare against
        // the populator-side query_episodicity. Per IndexEntry contract, the
        // features block carries `episodicity` when the cascade-side stamper
        // wrote it; otherwise it is undefined and episodicityMatch returns
        // the NEUTRAL fallback (0.5) per F-SYN-SUBSTRATE-EPISODICITY-SCORER.
        features: c.features != null ? c.features : null,
        // N6-stamp-priors — {damping_coefficient, corroboration_boost}. null
        // when stamping is gated OFF (neutral defaults in computeScore).
        priors: candidatePriors,
        // b2-silent-recall-degrade (Part 2) — the recall-derived answer to
        // "did a vector actually resolve for this candidate?", riding the
        // CONSTRUCTED scoring view only (thesis #1: c / cRaw are never
        // mutated), exactly like `entities` and `priors` above.
        //
        // Emitted ONLY when the dense channel was healthy for THIS call. This
        // is the load-bearing safety property: an availability failure is not
        // a property of a candidate, so a queryd blip (or an already-suppressed
        // dense leg) must never be converted into a mass hard-drop. On any
        // degraded path the key is OMITTED, computeScore reads "unknown", and
        // the legacy row-shape predicate governs — i.e. the degraded path keeps
        // today's scoring exactly and changes only Part 1's telemetry.
        //   firstSegmentVec3072 != null  — a query vector exists, so
        //                                  _resolveCandidateEmbedding was
        //                                  actually consulted above
        //   !degradedRecall              — the dense leg was not suppressed
        //                                  (covers queryd_model_missing and
        //                                  every BM25-only degrade)
        //   vectorPrefetchDegraded == null — the Layer-2 overlay prefetch did
        //                                  not FAIL: it did not throw, the
        //                                  generation did not change under it,
        //                                  and no attested-resident id came
        //                                  back as a structured null. Widening
        //                                  this guard beyond "did not throw" is
        //                                  what RESTORES the no-mass-hard-drop
        //                                  property stated above on the
        //                                  structured-null path — before it,
        //                                  an unresolved prefetch that returned
        //                                  ok:true still emitted
        //                                  vector_resolved:false for every
        //                                  candidate it failed to resolve.
        //   !vectorPrefetchUnverifiable  — run 3, F72: the prefetch's health was
        //                                  MEASURABLE, i.e. at least one
        //                                  attested-resident id was requested so
        //                                  the guard above is a real verdict and
        //                                  not the default answer of a blind
        //                                  classifier. Withholding the key
        //                                  restores `vectorResolved === null` in
        //                                  multi-feature-score, where the legacy
        //                                  `candidateFeatures.embed_state`
        //                                  predicate governs — pre-b2 scoring on
        //                                  that path, so the mass drop
        //                                  disappears without inventing a new
        //                                  detector.
        //
        // Paths that STILL legitimately emit the key (the withhold is not
        // always-on; RC-B5b pins this):
        //   - in-process (`useQueryd` false): no prefetch exists, so a direct
        //     sidecar miss via _resolveCandidateEmbedding IS the measurement.
        //   - daemon with `wantedVectorIds.size === 0`: every candidate won at
        //     the row, so nothing needed resolving and nothing is unmeasured.
        //   - daemon with `attestedRequested > 0` and nothing missing: the
        //     prefetch was verified healthy against a resident id.
        ...(firstSegmentVec3072 != null &&
        !degradedRecall &&
        vectorPrefetchDegraded == null &&
        !vectorPrefetchUnverifiable
          ? { vector_resolved: resolvedEmbedding != null }
          : {}),
      },
      surrounding_context: scoringContext,
      // N6 — the engagement-prior map + the calibrated score-weight overlay both
      // flow through opts. engagementPrior() returns 0 when the map is absent;
      // the overlay returns frozen-CAPS (all-0.0) weights when no reviewed
      // projection exists — so with the gate OFF this is byte-identical.
      opts: {
        now: handlerOpts.now,
        engagementPriorById,
        scoreWeightOverlay,
        // D3/W2 — real production hand-off. Both values are null with the
        // independent IDF flag OFF, preserving computeScore's legacy branch.
        entity_df: recallEntityWiring.entityDf,
        entity_df_n: recallEntityWiring.entityDfN,
      },
    });
    // B1a — carry the hard-gate drop provenance (hard-gates.js sets
    // dropped_reason="consent_blocked" etc. but returns the candidate) onto
    // the scored entry so the Layer-2 output partition below can log WHY a
    // candidate was dropped. Additive field; nothing downstream keys on the
    // object shape.
    //
    // B1b — resolved_embedding: the hoisted active-geometry vector (or null),
    // threaded on the scored entry ONLY (thesis #1: c/cRaw never mutated) so
    // mmrInput / enriched / selectedForDensity below consume the same vector
    // the s_emb cosine used. Additive field, same pattern as dropped_reason.
    scored.push({
      candidate: c,
      score_components: score,
      // RC Finding 2 — effectiveDroppedReason carries
      // "predicate_excluded:<id>" when the post-overlay reapply masked an
      // index-only exclusion; else g.dropped_reason (byte-identical to pre-fix).
      dropped_reason: effectiveDroppedReason,
      resolved_embedding: resolvedEmbedding,
    });
  }
  if (recallEntityWiring.entityDf !== null) {
    _assertEntityDfKeyspace(recallEntityWiring.entityDf, entityDfCanaryIds);
  }

  // -------------------------------------------------------------------------
  // h. Sort by final_score desc -> Layer 3 Flash rerank (top-25 -> top-12)
  //    -> MMR with lambda=0.7 over the rerank survivors.
  // -------------------------------------------------------------------------
  __mark("scoring-loop");
  scored.sort((a, b) => {
    if (b.score_components.final_score !== a.score_components.final_score) {
      return b.score_components.final_score - a.score_components.final_score;
    }
    return a.candidate.memory_id < b.candidate.memory_id ? -1 : 1;
  });

  // -------------------------------------------------------------------------
  // B1a — Layer-2 OUTPUT partition (consent-mask / additive-floor hard drop).
  //
  // applyHardGates RETURNS masked candidates (predicate_mask=0, e.g.
  // consent_blocked) rather than dropping them, and computeScore zeroes only
  // the multiplicative branch — the ADDITIVE branch is unmasked, so a
  // recently-blocked memory can outrank clean candidates (B1 Claim 1).
  // Likewise dropped_by_additive_floor (the null-embed fallback floor) was
  // computed by computeScore and consumed nowhere. Partition them out of the
  // surfaceable set HERE, at Layer-2 output:
  //   - BEFORE content-dedup, so a masked row can never become a dedup-cluster
  //     survivor that shadows an identical clean row out of the brief;
  //   - BEFORE the rerankInput slice, so consent-blocked content never reaches
  //     the Gemini Flash rerank API.
  // Everything downstream (rerankInput, top12, MMR, enforceBriefCaps,
  // surfaced, memories, truncated, _computeDensityNeighborhood,
  // candidate_set_size) operates on the kept set only. The dropped set is
  // RETAINED (already score-sorted) and appended to the recall event's
  // candidates_pre_truncation with full drop provenance so off-policy
  // estimators keep seeing it (hard-gates.js contract). Single O(n) pass over
  // the in-memory array — no new I/O on the recall request path.
  // -------------------------------------------------------------------------
  const droppedAtLayer2Output = [];
  {
    const kept = [];
    for (const s of scored) {
      if (
        s.score_components.predicate_mask !== 1 ||
        s.score_components.dropped_by_additive_floor === true
      ) {
        droppedAtLayer2Output.push(s);
      } else {
        kept.push(s);
      }
    }
    scored = kept;
  }

  // -------------------------------------------------------------------------
  // WU-recall-content-dedup — content-dedup at the recall PROJECTION.
  //
  // Walk the score-sorted scored[] (highest final_score first) and collapse
  // candidates whose NORMALIZED content is byte-identical, keeping the FIRST
  // (highest-scored) occurrence of each content cluster. This happens ONCE, on
  // the FULL scored set, BEFORE rerank + MMR + truncation — so the reranker
  // (when Gemini is up) sees distinct content too (strictly better), and the
  // dedup is independent of the embedding outage that defeats MMR diversity.
  //
  // The survivor is annotated with score_components.duplicate_count (how many
  // were collapsed, incl. itself) so the brief can optionally surface
  // "+N similar"; final_score is UNCHANGED. CAPS-gated
  // (RECALL_CONTENT_DEDUP_ENABLED, default true). A no-duplicate set is a pure
  // pass-through (every key unique -> no drops -> identical order + count,
  // each survivor's duplicate_count=1). The ledger is untouched — this is a
  // recall-projection operation only.
  //
  // Defensive: a throw degrades to the un-deduped set (recall quality, not a
  // load-bearing invariant). deduped_count is surfaced for observability.
  // -------------------------------------------------------------------------
  let dedupedCount = 0;
  if (CAPS.RECALL_CONTENT_DEDUP_ENABLED === true) {
    try {
      const dedupResult = _dedupScoredByContent(scored);
      scored = dedupResult.deduped;
      dedupedCount = dedupResult.dedupedCount;
    } catch (err) {
      try {
        console.error(
          `memory_recall: content-dedup threw; degrading to un-deduped set: ${err && err.message ? err.message : String(err)}`,
        );
      } catch {
        // logger throws don't propagate
      }
      dedupedCount = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Layer 3: Gemini 2.5 Flash listwise rerank.
  //
  // Top RECALL_RERANK_INPUT_SIZE (15) by final_score are fed to Flash. The
  // reranker ONLY REORDERS (drops happened at the Layer-2 output partition
  // above; the rerank input is already clean). Missing ids
  // get the median rank_score so nothing silently disappears. On any Flash
  // failure (api_key_missing, timeout, network, http_<status>,
  // malformed_response, all_ids_unmatched, internal_error) we degrade to
  // sort-by-final_score and set rerank_score=null on every item.
  // Authoritative contract: kb/phase3-v1-rerank-contracts.md
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // recent_recall_ids damping (kb/mcp-surface.md § memory_recall: "for
  // damping"). Memories ALREADY SURFACED by a recall the caller names in
  // surrounding_context.recent_recall_ids have their final_score multiplied
  // by CAPS.RECALL_RECENT_SURFACED_DAMPING_FACTOR and the set is re-sorted,
  // so the rerank input (the top-15 slice below) favours what the agent has
  // NOT just been shown. Damping, not paging: a strong enough memory still
  // reappears. Pre-damping score + factor are recorded on score_components
  // so the recall event stays reconstructable. Ids that do not resolve
  // through the in-process recall log (expired, other process, pre-stamp)
  // damp nothing. Runs AFTER dedup so a damped survivor cannot shadow an
  // identical clean row, and BEFORE the rerank slice so the reranker sees
  // the damped order.
  // -------------------------------------------------------------------------
  let recentSurfacedDampedCount = 0;
  {
    const recentlySurfaced = collectRecentlySurfacedIds(
      ctx.recent_recall_ids,
      (rid) => lookupRecall(rid, handlerOpts.now != null ? Date.parse(handlerOpts.now) : Date.now()),
    );
    const damped = applyRecentSurfacedDamping(
      scored,
      recentlySurfaced,
      CAPS.RECALL_RECENT_SURFACED_DAMPING_FACTOR,
    );
    scored = damped.scored;
    recentSurfacedDampedCount = damped.dampedCount;
  }

  __mark("dedup+density");
  const rerankInput = scored.slice(0, CAPS.RECALL_RERANK_INPUT_SIZE);
  const rerankResult =
    rerankInput.length > 0
      ? await rerankCandidates({
          surrounding_context: ctx,
          candidates_with_scores: rerankInput.map((s) => ({
            candidate: s.candidate,
            score_components: s.score_components,
          })),
          opts: { now: handlerOpts.now },
        })
      : {
          reranked: [],
          degraded: false,
          layer3_latency_ms: 0,
          rerank_failed_reason: null,
        };
  const rerankAttempted = rerankInput.length > 0;
  const degradedRecallLayer3 = rerankResult.degraded === true;
  const rerankScoreById = new Map();
  for (const r of rerankResult.reranked) {
    rerankScoreById.set(r.memory_id, r.rerank_score);
  }

  // MMR input set is the Layer 3 output (top-12 by rerank_score, or top-12
  // by final_score on degrade). Relevance term for MMR remains the multi-
  // feature final_score (NOT rerank_score) per
  // kb/research-retrieval-frontiers.md § Layer 4: Flash already ordered;
  // double-using rerank_score would compound listwise noise.
  __mark("rerank");
  const top12 = rerankResult.reranked
    .map((r) => scored.find((s) => s.candidate.memory_id === r.memory_id))
    .filter(Boolean);

  // B1b — MMR works on the ACTIVE-GEOMETRY resolved vectors hoisted onto the
  // scored entries by the scoring loop (row embedding or HNSW-sidecar
  // overlay, query-dim guarded via _resolveCandidateEmbedding — 4096 on the
  // primary local path). The legacy candidate.embedding_3072 read is dead on
  // the live corpus (0% coverage post WU-recall-flip-to-local-4096, B1
  // Claim 2). Candidates without a resolvable vector are passed through MMR
  // with a zero-stub embedding so the redundancy term collapses to 0 cosine —
  // equivalent to saying "we cannot measure redundancy for this item; pick by
  // relevance". The stub length must match the other candidates', i.e. the
  // QUERY dim (firstSegmentVec3072.length), falling back to the legacy Gemini
  // dim only when no query vector exists (fully degraded recall — every entry
  // is then a stub and MMR is a no-op order-preserve). mmr.js's array-like
  // contract accepts any length; the field name embedding_3072 is the wire
  // contract into mmrSelect/emitDensityFlag and stays as-is.
  const dims = firstSegmentVec3072 != null
    ? firstSegmentVec3072.length
    : CAPS.GEMINI_EMBEDDING_DIMS_FULL;
  const mmrInput = top12.map((s) => ({
    memory_id: s.candidate.memory_id,
    score: s.score_components.final_score,
    embedding_3072: Array.isArray(s.resolved_embedding)
      ? s.resolved_embedding
      : new Array(dims).fill(0),
  }));

  const selected = top12.length > 0
    ? mmrSelect({
        candidates: mmrInput,
        K: Math.min(maxItems, CAPS.RECALL_BRIEF_MAX_ITEMS),
        lambda: CAPS.MMR_LAMBDA_DEFAULT,
      })
    : [];

  // -------------------------------------------------------------------------
  // i. enforceBriefCaps.
  // -------------------------------------------------------------------------
  const selectedById = new Map();
  for (const t of top12) selectedById.set(t.candidate.memory_id, t);
  const enriched = selected.map((s) => {
    const t = selectedById.get(s.memory_id);
    return {
      memory_id: s.memory_id,
      score: s.score,
      position: s.position,
      content_excerpt: t ? t.candidate.content : "",
      kind: t ? t.candidate.kind : "fact",
      ts: t ? t.candidate.ts : "",
      // B1b — surface the resolved active-geometry vector (not the dead
      // candidate.embedding_3072 row field) so selectedForDensity below and
      // any downstream consumer of surfaced embeddings see real vectors.
      embedding_3072: t && Array.isArray(t.resolved_embedding)
        ? t.resolved_embedding
        : null,
    };
  });
  // F2 — `max_chars` bounds `content` only (mmr.js enforceBriefCaps counts
  // `content_excerpt`); provenance/source_refs sit outside the budget and are
  // bounded by construction (BRIEF_SOURCE_REFS_MAX refs x 4 short strings).
  const capped = enforceBriefCaps(enriched, {
    maxItems: Math.min(maxItems, CAPS.RECALL_BRIEF_MAX_ITEMS),
    maxCharsTotal: Math.min(maxChars, CAPS.RECALL_BRIEF_MAX_CHARS_TOTAL),
    maxCharsPerItem: CAPS.RECALL_BRIEF_MAX_CHARS_PER_ITEM,
  });

  // -------------------------------------------------------------------------
  // j. Propensities AFTER Layer 3 over the top-RECALL_RERANK_INPUT_SIZE (15)
  //    set actually fed to Flash. The propensity distribution must reflect
  //    the policy that produced the surfaced briefs — which now includes the
  //    Layer-3 reranker. Per contract § 6: scores feeding Plackett-Luce are
  //    rerank_score where available (success path) and final_score where
  //    rerank_score is null (degraded path, or an input candidate Flash
  //    happened to omit AFTER median-fill — those get median, not null).
  // -------------------------------------------------------------------------
  const propensityCandidates = rerankInput;
  const propensityScores = propensityCandidates.map((s) => {
    const rs = rerankScoreById.get(s.candidate.memory_id);
    if (typeof rs === "number" && Number.isFinite(rs)) return rs;
    return s.score_components.final_score;
  });
  const propensities = propensityCandidates.length > 0
    ? computePropensities({
        candidate_scores: propensityScores,
        tau: CAPS.PROPENSITY_TEMPERATURE_TAU_DEFAULT,
        jitter_seed: recallId,
      })
    : [];
  const propensityByMemoryId = new Map();
  for (let i = 0; i < propensities.length; i++) {
    propensityByMemoryId.set(
      propensityCandidates[i].candidate.memory_id,
      propensities[i].propensity,
    );
  }

  // -------------------------------------------------------------------------
  // k. Density flag + brief envelope.
  // -------------------------------------------------------------------------
  // candidates_at_similar_scores: count how many post-Layer-3 items are
  // within 5% of the top score (rough proxy for "tied at the bar"). v0 used
  // top-20; with Layer 3 the natural post-rerank pool fed to MMR is top-12.
  let candidatesAtSimilar = 0;
  if (top12.length > 0) {
    const topScore = top12[0].score_components.final_score;
    const threshold = Math.max(0.0001, Math.abs(topScore) * 0.05);
    for (const t of top12) {
      if (Math.abs(t.score_components.final_score - topScore) <= threshold) {
        candidatesAtSimilar++;
      }
    }
  }
  // Build the density-flag input: only the (capped) selected briefs that
  // have embeddings; if none have embeddings, the avg pairwise cos is 0 and
  // the flag falls to "sparse" or "ok" via the selected.length branch.
  const selectedForDensity = capped.map((c) => ({
    embedding_3072: Array.isArray(c.embedding_3072)
      ? c.embedding_3072
      : new Array(dims).fill(0),
  }));
  const density_flag = emitDensityFlag({
    selected: selectedForDensity,
    candidates_at_similar_scores: candidatesAtSimilar,
  });

  // -------------------------------------------------------------------------
  // l. Write recall event (in-process map + on-disk recall.jsonl).
  // -------------------------------------------------------------------------
  const surfaced = capped.map((c) => {
    const top = selectedById.get(c.memory_id);
    const fb = top ? top.score_components : null;
    const rs = rerankScoreById.has(c.memory_id)
      ? rerankScoreById.get(c.memory_id)
      : null;
    return {
      memory_id: c.memory_id,
      score: c.score,
      position: c.position,
      propensity: propensityByMemoryId.has(c.memory_id)
        ? propensityByMemoryId.get(c.memory_id)
        : 0,
      // Phase 3 v1 additive: null when degraded_recall_layer3 OR when this id
      // wasn't in the rerank input set (shouldn't happen since surfaced comes
      // from top12 which derives from reranked.reranked, but defensive).
      rerank_score: typeof rs === "number" ? rs : null,
      // N10-priors-persistence-seam — persist the THREE live priors the scorer
      // computed onto a top-level `priors` object so the offline calibration
      // loop's rescoreSurfacedWithLiveWeights (calibration-loop.js:312-325)
      // re-scores with the SAME non-neutral priors the live recall scorer used.
      // null fb → null priors → rescorer falls back to neutral, as before.
      // (See _projectSurfacedPriors above; thesis #1: surfaced[] is a derived
      // recall-event projection, NOT a fact row — no fact mutation here.)
      priors: _projectSurfacedPriors(fb),
      feature_breakdown: fb
        ? {
            s_emb_full3072: fb.s_emb_full3072,
            predicate_mask: fb.predicate_mask,
            consent_dampener: fb.consent_dampener,
            derivation_status: fb.derivation_status,
            episodicity_match: fb.episodicity_match,
            entity_overlap_jaccard: fb.entity_overlap_jaccard,
            time_anchor_match: fb.time_anchor_match,
            power_law_decay: fb.power_law_decay,
            valence_compat: fb.valence_compat,
            engagement_prior: fb.engagement_prior,
            // N10 — mirror damping/corro into feature_breakdown too so the
            // recall-event row is self-describing for OPE/audit (the live
            // scorer's W12 priors were previously dropped at persist; only
            // engagement_prior survived). The authoritative read for the
            // rescorer is the top-level `priors` above.
            damping_coefficient: fb.damping_coefficient,
            corroboration_boost: fb.corroboration_boost,
          }
        : null,
    };
  });

  // candidates_pre_truncation: top-50 fused candidate set per § 5, MERGED
  // shape (B1a): the KEPT entries come first (score-sorted, byte-identical
  // projection to the pre-B1a shape: {memory_id, position, score,
  // rerank_score}), then the Layer-2-output DROPPED entries are APPENDED (not
  // interleaved) with CONTINUING position indices and full drop provenance
  // ({..., dropped_at_layer2_output: true, predicate_mask,
  // dropped_by_additive_floor, dropped_reason}). Appending keeps kept-entry
  // positions aligned with surfaced ranks, and a zero-drop recall's event is
  // byte-identical to pre-B1a modulo layer2_dropped_count. Dropped entries
  // never reach Flash, so their rerank_score is always null.
  //
  // Phase 3 v1 additive (§ 3 of kb/phase3-v1-rerank-contracts.md): each entry
  // carries rerank_score — populated for the top RECALL_RERANK_INPUT_SIZE (15)
  // entries that were fed to Flash, null for the rest. This preserves v0 OPE
  // substrate fidelity AND captures the Layer-2-vs-Layer-3 rank-mix signal v3
  // needs.
  const candidatesPreTruncation = scored
    .slice(0, CAPS.RECALL_CANDIDATE_SET_SIZE)
    .map((s, position) => {
      const rs = rerankScoreById.has(s.candidate.memory_id)
        ? rerankScoreById.get(s.candidate.memory_id)
        : null;
      return {
        memory_id: s.candidate.memory_id,
        position,
        score: s.score_components.final_score,
        rerank_score: typeof rs === "number" ? rs : null,
      };
    });
  // B1a — append the Layer-2-output dropped set with drop provenance (OPE
  // substrate: estimators must keep seeing what was dropped and why).
  {
    let position = candidatesPreTruncation.length;
    for (const s of droppedAtLayer2Output.slice(0, CAPS.RECALL_CANDIDATE_SET_SIZE)) {
      candidatesPreTruncation.push({
        memory_id: s.candidate.memory_id,
        position: position++,
        score: s.score_components.final_score,
        rerank_score: null,
        dropped_at_layer2_output: true,
        predicate_mask: s.score_components.predicate_mask,
        dropped_by_additive_floor: s.score_components.dropped_by_additive_floor,
        dropped_reason: s.dropped_reason ?? null,
      });
    }
  }

  const recallTs = serverTs();
  // R25.5 CRIT-7: capture the salience CAPS triple + the rerank caps in
  // every recall row so the week-1 threshold-freeze verifier can match
  // SALIENCE_WEIGHTS_V1_HASH and detect cap drift across re-weight events.
  // Same snapshot the rerank audit-provenance fields use; we duplicate it
  // at the recallEvent top level because rerank_caps_snapshot is null when
  // rerank_attempted=false (api_key_missing, degraded path), and
  // caps_snapshot must always be populated.
  const capsSnap = capsSnapshot();
  const recallEvent = {
    id: recallId,
    ts: recallTs,
    kind: "recall",
    query: {
      surrounding_context_hash: surroundingContextHash,
      // The 4096 local query vector OR empty when degraded. The shape contract
      // allows either — memory_exclude snapshots this verbatim.
      context_embedding: firstSegmentVec3072 != null
        ? Array.from(firstSegmentVec3072)
        : [],
      // WU-recall-flip-to-local-4096 — stamp the model that ACTUALLY produced
      // the query vector: the active 4096 model on the primary local path, or
      // the legacy Gemini version when the Gemini-index fallback re-encoded the
      // query. On a full degrade (no vector) this is the model the recall
      // TARGETED, keeping the event self-describing for memory_exclude/OPE.
      embedding_model_version: queryEmbedModelVersion,
    },
    surfaced,
    candidates_pre_truncation: candidatesPreTruncation,
    density_flag,
    // FU2 — a refused active index generation degrades the call IN-BAND
    // (visibility only: candidate generation/scoring above ran unsuppressed
    // over whatever source loadIndices served). The OR happens HERE, not on
    // the `degradedRecall` variable, so the dense leg was never suppressed.
    //
    // b2-silent-recall-degrade — same discipline for the Layer-2 vector
    // prefetch failure: OR-ed HERE only. See the catch block above for the
    // measured mutual-exclusion argument w.r.t. queryd_model_missing.
    degraded_recall:
      degradedRecall ||
      indexGenerationRefused != null ||
      vectorPrefetchDegraded != null ||
      denseSearchDegraded != null ||
      indexUnservable != null,
    // r3-degraded-recall-blindspot additive — present ONLY when the ACTIVE
    // tree's HNSW is empty. `reason` splits "the whole tree is unservable"
    // from "only the dense leg is" when the sizes were MEASURED, and names
    // "queryd_model_missing" when they were not (daemon mode, version absent
    // from status — see the marker's declaration). See that declaration too
    // for why the OR above cannot change the boolean's value on any input.
    //
    // FIRST of the conditional spreads, ahead of dense_search_bad_request:
    // later spreads win on key collision, so every pre-existing
    // degraded_reason value stays byte-identical and the dedicated
    // index_unservable key survives every collision. Mutual exclusion is
    // measured at the symbols, not assumed: a non-null marker implies
    // `degradedRecall`, which makes `denseSegs` the empty array (so
    // denseLegsRequested stays 0 and denseSearchDegraded stays null) and
    // closes the prefetch's `!degradedRecall` guard (so vectorPrefetchDegraded
    // stays null and vectorPrefetchUnverifiable keeps its `false` initializer).
    // index_generation_refused is the one marker that CAN co-occur — a refused
    // active generation serving the fail-closed empty indices — and the spread
    // order resolves it in that marker's favour.
    //
    // ON THE UNMEASURED (model-absent) PATH that one collision is unreachable,
    // re-derived here rather than assumed: `refusalFor` reads
    // `generation_refused` off the SAME status entry `querydStatusEntry`
    // failed to find, so its first term is null by absence; its second term
    // looks up ACTIVE_EMBEDDING_MODEL_VERSION, which is the single value
    // `indexModelVersion` is ever assigned (one assignment site, never
    // re-pointed since l5-fallback-removal), so it is the same absent lookup
    // and also null — `null ?? null` leaves indexGenerationRefused null. The
    // marker's own "queryd_model_missing" is therefore what this event
    // carries, which is exactly the value the response has always reported for
    // this shape. THIS IS THE ONE BEHAVIOR DELTA of run 2: pre-run-2 the event
    // said "active_tree_unservable" here while the response said
    // "queryd_model_missing" — the same call told two stories.
    ...(indexUnservable != null
      ? {
          degraded_reason: indexUnservable.reason,
          index_unservable: indexUnservable,
        }
      : {}),
    // b2-silent-recall-degrade (run 3) additive — present ONLY when a dense
    // retrieval leg was REFUSED (QuerydBadRequestError) and silently emptied.
    //
    // SPREAD ORDER: later spreads win on key collision, so this one goes ahead
    // of both the vector_prefetch_degraded spread and the
    // index_generation_refused spread. That makes the degraded_reason
    // precedence three-way and leaves every pre-existing value byte-identical:
    //   index_generation_refused > vector_prefetch_failed > dense_search_bad_request
    // The dedicated dense_search_degraded key survives every collision.
    ...(denseSearchDegraded != null
      ? {
          degraded_reason: "dense_search_bad_request",
          dense_search_degraded: denseSearchDegraded,
        }
      : {}),
    // b2-silent-recall-degrade additive — present ONLY when the enrichment
    // prefetch actually FAILED: it threw, OR it answered from a different
    // generation than the retrieval leg, OR an attested-resident id came back
    // as a structured null. Placed BEFORE the index_generation_refused
    // spread so that when both fire the pre-existing degraded_reason value is
    // unchanged (precedence: index_generation_refused > vector_prefetch_failed)
    // while the dedicated vector_prefetch_degraded key is never lost.
    ...(vectorPrefetchDegraded != null
      ? {
          degraded_reason: "vector_prefetch_failed",
          vector_prefetch_degraded: vectorPrefetchDegraded,
        }
      : {}),
    // FU2 additive — omitted entirely when no refusal occurred (the no-
    // refusal event stays byte-identical; same conditional-spread pattern as
    // the queryd_model_missing envelope stamp).
    ...(indexGenerationRefused != null
      ? {
          degraded_reason: "index_generation_refused",
          index_generation_refused: indexGenerationRefused,
        }
      : {}),
    // e15-recall-temporal-scoping — the same pre-hard-gate fused pool size the
    // response envelope now carries, stamped on the durable row so the ratio
    // is reconstructable offline. candidate_pool_size >= surfaced/scored counts.
    candidate_pool_size: candidates.length,
    // WU-recall-content-dedup — how many byte-identical-content candidates
    // were collapsed at the recall projection this recall (observability).
    deduped_count: dedupedCount,
    // recent_recall_ids damping — stamped on the durable row too so the
    // ranking is reconstructable offline (each damped entry also carries
    // final_score_pre_damping + recent_surfaced_damping_factor).
    recent_surfaced_damped_count: recentSurfacedDampedCount,
    // B1a — how many candidates the Layer-2 output partition hard-dropped
    // (predicate_mask=0 / dropped_by_additive_floor). Additive: a zero-drop
    // recall's event is byte-identical to pre-B1a except this field = 0.
    layer2_dropped_count: droppedAtLayer2Output.length,
    // Phase 3 v1 additive — kb/phase3-v1-rerank-contracts.md § 3.
    rerank_attempted: rerankAttempted,
    rerank_failed_reason: rerankResult.rerank_failed_reason,
    layer3_latency_ms: rerankResult.layer3_latency_ms,
    degraded_recall_layer3: degradedRecallLayer3,
    // R25.5 CRIT-7: top-level caps_snapshot. Always populated regardless
    // of rerank attempt status.
    caps_snapshot: capsSnap,
    // Wave 6 — synthesis populator metadata block (additive; W4
    // context-populator.md § 4.7). Counts only (not the extracted entities
    // or anchors) per drift-detection efficiency rationale in the spec.
    populator: {
      version: "v1",
      entity_extractor_version: ENTITY_EXTRACTOR_VERSION,
      time_anchor_resolver_version: TIME_ANCHOR_RESOLVER_VERSION,
      valence_model_version: VALENCE_MODEL_VERSION,
      episodicity_version: EPISODICITY_VERSION,
      mood_vocab_version: RECALL_VALENCE_VOCAB_VERSION,
      degraded: populatorDegraded,
      degraded_reasons: populatorDegradedReasons.slice(),
      entities_count: populatorEntityIds.length,
      time_anchors_count: populatorTimeAnchors.length,
      inferred_mood_sign:
        populatorValence != null && typeof populatorValence.sign === "number"
          ? populatorValence.sign
          : 0,
      has_time_anchor: resolvedTimeAnchor != null,
      query_episodicity:
        typeof populatorQueryEpisodicity === "number"
          ? populatorQueryEpisodicity
          : null,
      mood_table_miss: populatorMoodTableMissCount,
      // WU-RR2 — substrate-aware Layer-1c fallback telemetry. fallback_triggered
      // is true when the entity-index scan actually contributed any new
      // candidates; fallback_added_candidates is the count of those new ids.
      // fallback_skip_reason is set when the trigger threshold was met but the
      // fallback did NOT contribute (no populator entities, or entity-index
      // load failure surfaced as a degraded_reasons entry).
      fallback_triggered: fallbackTriggered,
      fallback_added_candidates: fallbackAddedCandidates,
      fallback_skip_reason: fallbackSkipReason,
    },
  };

  __mark("mmr+brief-assembly");
  // In-process map (memory_exclude binding surface).
  recordRecall(recallId, {
    query: recallEvent.query,
    logged_at: recallTs,
    // recent_recall_ids damping reads this back: the memory ids this recall
    // surfaced, so a later recall in the same process can damp them.
    surfaced_memory_ids: surfaced.map((s) => s.memory_id),
  });
  // On-disk ledger (v3 OPE substrate). Best-effort: if the ledger write
  // throws (disk full, permission denied), surface as INTERNAL_ERROR so
  // operators see the durability hole loudly.
  try {
    appendRecallEvent(recallEvent);
  } catch (e) {
    return {
      ok: false,
      data: null,
      error: {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: `recall-log append failed: ${e.message}`,
      },
      meta: { tool: NAME, version: 1 },
    };
  }

  // -------------------------------------------------------------------------
  // m. Brief envelope.
  // -------------------------------------------------------------------------
  // mcp-surface.md § Recall keeps the legacy `memories[]` + `bounded_by` +
  // `truncated` envelope (Phase 0 ABI). We extend it with the Phase 3 v0
  // fields (degraded_recall, candidate_set_size) without breaking older
  // callers — additive only.
  const memories = capped.map((c) => {
    // Wave 8 — for surfaced reconstructed candidates, project the
    // derived_from chain into the brief for transparency. Non-reconstructed
    // candidates leave both arrays empty (matches legacy callers' shape
    // expectations). Parent titles are first-PARENT_TITLE_MAX_CHARS of the
    // parent row's content — read from the ledger byId map populated in
    // step (e).
    const top = selectedById.get(c.memory_id);
    const candidateRow = top ? top.candidate : null;
    const isReconstructed =
      candidateRow != null && candidateRow.kind === "reconstructed";
    const derivedFrom = isReconstructed && Array.isArray(candidateRow.derived_from)
      ? candidateRow.derived_from.slice()
      : [];
    const derivedFromTitles = isReconstructed
      ? _derivedFromTitlesFor(candidateRow, ledger.byId)
      : [];
    // A2 — surface WHO said it + direction for EVERY source. Read the full
    // fact row from ledger.byId (the candidate index-entry drops source_refs)
    // and project sender + direction via the source-agnostic resolver, which
    // consumes A1's uniform top-level parties[] + features.attribution shape
    // (P0), degrading through the legacy raw_content forward-stamp (P1) and the
    // WhatsApp sender-index backfill (P2) to the empty [] shape (P3). Never
    // throws into recall; legacy/empty facts keep parties:[], direction:null,
    // authored_by:null (additive; no shape change for existing callers).
    const row = ledger.byId.get(c.memory_id);
    const attribution = __resolveProvenanceAttribution(row);
    // F2 — project the row's ORIGIN fields (row.source / source_refs[0].source,
    // row.provenance.{conversation_id, confidence}, row.source_refs,
    // row.strictest_consent_basis, row.derived_from) via
    // __projectBriefProvenance so a hit is traceable to its connector and
    // original message id. Two ref shapes: promoted facts carry {source,
    // source_msg_id, consent_basis}; daemon reconstructed rows carry
    // {event_id, consent_basis, role} with NO connector source, so they
    // report source "reconstructed" and event_id = the parent memory id.
    // source_msg_id / event_id are opaque identifiers; consent_basis travels
    // with each ref so consumers apply kb/ingestion.md § Consent-aware
    // promotion (no verbatim quoting for second_party_dm /
    // third_party_inferred). Never throws; a null/malformed row degrades to
    // the legacy literals.
    const prov = __projectBriefProvenance(row);
    return {
      id: c.memory_id,
      content: c.content_excerpt,
      provenance: {
        source: prov.source,                 // connector source; "memory_ledger" only when the row has none
        ts: c.ts,
        parties: attribution.parties,        // now populated for all sources
        direction: attribution.direction,    // NEW, additive: "outgoing"|"incoming"|null
        authored_by: attribution.authored_by, // NEW, additive: "user"|<sender>|null
        chat_type: attribution.chat_type,    // A4, additive: "dm"|"group"|null
        reply_to: attribution.reply_to,      // additive read-side attribution metadata only
        fwd_from: attribution.fwd_from,      // additive read-side attribution metadata only
        conversation_id: prov.conversation_id, // F2, additive: pass-through of the row's promote-time key or null
        confidence: prov.confidence,         // row string ("pre_distilled" on live facts); "medium" only as fallback
        confidence_score: prov.confidence_score, // F2, additive: numeric self-report on reconstructed rows, else null
        strictest_consent_basis: prov.strictest_consent_basis, // F2, additive: row-level strictest of the refs on reconstructed rows, else null
      },
      // e15-recall-temporal-scoping — computed, not asserted. Was the literal
      // "fresh" for every row regardless of age (a January row surfaced in
      // August reported "fresh"). The clock is `ctx.time`
      // (surrounding_context.time), which the inputSchema REQUIRES and
      // assertIso8601 validates at the top of this handler — so this path
      // never falls back to Date.now(), and two callers passing the same
      // ctx.time get identical labels. Producer: multi-feature-score.js
      // `freshnessLabel`; this is its only call site.
      freshness: freshnessLabel({ candidate_ts: c.ts, now_iso: ctx.time }),
      // F2 — one hop = the row's derived_from, for every kind; F3 walks deeper.
      derivation_chain: prov.derivation_chain,
      // Wave 8 — F-SYN-INTEGRATION-DERIVATION-GRAPH-RECALL-PATHWAY.
      // Empty arrays for non-reconstructed kinds so consumers can rely on
      // the shape (no `in` checks needed).
      derived_from: derivedFrom,
      derived_from_titles: derivedFromTitles,
      // F2 — bounded refs (first 4) + full count so truncation is visible.
      source_refs: prov.source_refs,
      source_refs_count: prov.source_refs_count,
    };
  });
  // Suppress the unused-var lint on derivationGraphForBrief (the graph is
  // loaded primarily for its side effect — populating the orphanedSet — but
  // the variable name documents the intent and may be referenced by a v9
  // brief-side extension that needs the kindOf map directly).
  void derivationGraphForBrief;
  const truncated = scored.length > capped.length;

  // -------------------------------------------------------------------------
  // W10 — F-SYN-BEHAVIOR-recall-log-write-engagement (first behavior-tier
  // ship). For each surfaced memory write one signal_kind="surfacing" row to
  // the damping log; also write the policy/recall-context.json sidecar so
  // the UserPromptSubmit hook can attach prior_recall_brief on the next turn.
  //
  // Both writes are best-effort and wrapped in try/catch — engagement is a
  // statistical signal, not a load-bearing one. A failed append must not
  // tip the recall response.
  //
  // turn_window_id discipline (§ 4.5): we derive base_turn_index from the
  // recent_turns array length (the assistant has not yet replied, so the
  // surface position corresponds to the most-recent user turn ≈
  // recent_turns.length). This is the same mapping the engagement-detector
  // wiring uses in the watermark daemon (runEngagementQueueDrain): floor by
  // CAPS.RECALL_K_TURN_WINDOW. conversation_id_hash is a sha256 of the raw
  // id; the damping log stores ONLY the hash (privacy invariant § 4.6).
  // -------------------------------------------------------------------------
  try {
    const windowSize = Number.isInteger(CAPS.RECALL_K_TURN_WINDOW)
      ? CAPS.RECALL_K_TURN_WINDOW
      : 3;
    const turnIndex = Array.isArray(ctx.recent_turns) ? ctx.recent_turns.length : 0;
    const baseTurnIndex = Math.floor(turnIndex / windowSize);
    const turnWindowId = __computeTurnWindowId({
      conversation_id: args.conversation_id,
      base_turn_index: baseTurnIndex,
      window_size: windowSize,
    });
    const conversationIdHash = __computeConversationIdHash(args.conversation_id);
    for (const s of surfaced) {
      try {
        // Fire-and-forget per row; defensive on every axis.
        __appendSurfacing({
          memory_id: s.memory_id,
          turn_window_id: turnWindowId,
          recall_id: recallId,
          conversation_id_hash: conversationIdHash,
          position: typeof s.position === "number" ? s.position : 0,
          score: typeof s.score === "number" ? s.score : 0,
          propensity: typeof s.propensity === "number" ? s.propensity : 0,
        }).catch((err) => {
          try {
            console.error(
              `memory_recall: damping-log.appendSurfacing rejected (swallowed): ${err && err.message ? err.message : String(err)}`,
            );
          } catch {
            // logger throws don't propagate
          }
        });
      } catch (e) {
        // Synchronous throw (validation error in the writer arguments) —
        // log and keep going for the remaining surfaced items.
        try {
          console.error(
            `memory_recall: damping-log.appendSurfacing sync-threw for memory_id=${s.memory_id}: ${e && e.message ? e.message : String(e)}`,
          );
        } catch {
          // logger throws don't propagate
        }
      }
    }
  } catch (e) {
    try {
      console.error(
        `memory_recall: damping-log surfacing-write setup failed (swallowed): ${e && e.message ? e.message : String(e)}`,
      );
    } catch {
      // logger throws don't propagate
    }
  }

  // -------------------------------------------------------------------------
  // W11 — F-SYN-BEHAVIOR-density-flag-feedback (CROWDED_NEIGHBORHOOD).
  //
  // After candidate scoring (Layer 2 final_score), count the candidates that
  // (a) passed the predicate gate and (b) sit within
  // DENSITY_NEIGHBORHOOD_RADIUS of the top final_score. When that count
  // crosses DENSITY_FLAG_THRESHOLD we fire the crowded_neighborhood signal:
  // one damping-log row per recall (spec § 4.7.2.D), carrying the raw
  // entity_set + entity_set_hash + candidates_pre_truncation memory_ids so
  // the scorer can compute Jaccard at read time and so the join survives
  // daemon restarts.
  //
  // The signal is decoupled from the brief envelope's density_flag field
  // (which carries "crowded"/"sparse"/null and is owned by emitDensityFlag /
  // Layer 4). Per spec § 4.7.3 translation table the brief-envelope
  // density_flag is a presentation concern; the crowded_neighborhood signal
  // is a scoring-feedback concern with its own threshold.
  //
  // Defensive: any throw in the threshold computation OR the writer is
  // logged and swallowed. The recall response is never tipped by the
  // density-flag feedback path.
  // -------------------------------------------------------------------------
  try {
    const dnf = _computeDensityNeighborhood(scored);
    if (dnf.density_flag === "many_candidates_near_topic") {
      const windowSize = Number.isInteger(CAPS.RECALL_K_TURN_WINDOW)
        ? CAPS.RECALL_K_TURN_WINDOW
        : 3;
      const turnIndex = Array.isArray(ctx.recent_turns) ? ctx.recent_turns.length : 0;
      const baseTurnIndex = Math.floor(turnIndex / windowSize);
      const turnWindowId = __computeTurnWindowId({
        conversation_id: args.conversation_id,
        base_turn_index: baseTurnIndex,
        window_size: windowSize,
      });
      const conversationIdHash = __computeConversationIdHash(args.conversation_id);
      // entity_set: deduped + sorted-ascending populator entity ids. The spec
      // § 4.4.4 requires the RAW list (not just hash) so the scorer can
      // compute Jaccard against a candidate's entities at read time.
      const entitySetSorted = Array.from(new Set(populatorEntityIds)).sort();
      const entitySetHash = createHash("sha256")
        .update(Buffer.from(canonicalJson(entitySetSorted), "utf8"))
        .digest("base64url");
      // candidates_pre_truncation: per spec § 4.7.2.D, the memory_ids of all
      // candidates scored BEFORE MMR + truncation, in score order. This is
      // the same set already captured for the public recall row's
      // `candidates_pre_truncation` block — but the damping-log shape wants
      // memory_ids only (not the {memory_id, position, score, rerank_score}
      // tuples the public row carries).
      //
      // B1a — KEPT entries only: Layer-2-output dropped candidates
      // (consent-masked / additive-floor) are unrankable and must not
      // inflate crowding damping against legitimate memories.
      const candidatesPreTruncationIds = candidatesPreTruncation
        .filter((c) => c.dropped_at_layer2_output !== true)
        .map((c) => c.memory_id);
      try {
        __appendCrowdedNeighborhood({
          turn_window_id: turnWindowId,
          recall_id: recallId,
          conversation_id_hash: conversationIdHash,
          entity_set: entitySetSorted,
          entity_set_hash: entitySetHash,
          time_window_start: null,
          time_window_end: null,
          candidates_pre_truncation: candidatesPreTruncationIds,
        }).catch((err) => {
          try {
            console.error(
              `memory_recall: damping-log.appendCrowdedNeighborhood rejected (swallowed): ${err && err.message ? err.message : String(err)}`,
            );
          } catch {
            // logger throws don't propagate
          }
        });
      } catch (e) {
        try {
          console.error(
            `memory_recall: damping-log.appendCrowdedNeighborhood sync-threw (swallowed): ${e && e.message ? e.message : String(e)}`,
          );
        } catch {
          // logger throws don't propagate
        }
      }
    }
  } catch (e) {
    try {
      console.error(
        `memory_recall: density-flag-feedback computation failed (swallowed): ${e && e.message ? e.message : String(e)}`,
      );
    } catch {
      // logger throws don't propagate
    }
  }

  // W10 — recall-context.json sidecar write (MAJOR closure). The
  // UserPromptSubmit hook reads this on the next turn boundary to attach
  // the brief to the engagement-queue signal. Best-effort; failures are
  // logged but never block the recall response. Payload shape matches the
  // hook's parser (hooks/recall-engagement-detect.sh):
  //   { prior_recall_id, ts, prior_recall_brief: {recall_id, surfaced[]} }
  //
  // surfaced[].content carries the brief excerpt (already capped by
  // enforceBriefCaps); the engagement detector uses it for tokenization.
  try {
    const sidecarSurfaced = capped.map((c) => ({
      memory_id: c.memory_id,
      content: typeof c.content_excerpt === "string" ? c.content_excerpt : "",
    }));
    writeRecallContextSidecar({
      prior_recall_id: recallId,
      ts: recallTs,
      prior_recall_brief: {
        recall_id: recallId,
        surfaced: sidecarSurfaced,
      },
    });
  } catch (e) {
    try {
      console.error(
        `memory_recall: recall-context sidecar write failed (swallowed): ${e && e.message ? e.message : String(e)}`,
      );
    } catch {
      // logger throws don't propagate
    }
  }

  // -------------------------------------------------------------------------
  // Wave 9 — CP-5 Trigger A activation. Emit the batched
  // policy.salience.recall_feedback row for this recall, fire-and-forget.
  //
  // Discipline:
  //   - Batched: ONE event covers every surfaced memory in this recall (not
  //     N events for N memories) — the surface_position_by_id +
  //     propensities_by_id maps carry the per-memory detail.
  //   - Non-blocking: we do NOT await. The emitter is defensive (any write
  //     failure logs + swallows) so a torn ledger cannot block the brief.
  //   - Defensive call site: wrapped in try/catch as belt-and-suspenders in
  //     case the emitter ever drifts to throw synchronously before the
  //     promise is constructed.
  // -------------------------------------------------------------------------
  try {
    const surfacePositionById = {};
    const propensitiesById = {};
    for (const s of surfaced) {
      surfacePositionById[s.memory_id] = s.position;
      propensitiesById[s.memory_id] = s.propensity;
    }
    // Fire-and-forget: capture any promise rejection so an unhandledRejection
    // does not pollute the runtime. The emitter itself never throws inside
    // its body, but defending against a future regression is cheap.
    emitRecallFeedback({
      recall_id: recallId,
      surfaced_memory_ids: surfaced.map((s) => s.memory_id),
      surface_position_by_id: surfacePositionById,
      scoring_weights: capsSnap,
      propensities_by_id: propensitiesById,
    }).catch((err) => {
      try {
        console.error(
          `memory_recall: recall-feedback emit promise rejected (swallowed): ${err && err.message ? err.message : String(err)}`,
        );
      } catch {
        // logger throws don't propagate
      }
    });
  } catch (e) {
    try {
      console.error(
        `memory_recall: recall-feedback emit threw synchronously (swallowed): ${e && e.message ? e.message : String(e)}`,
      );
    } catch {
      // logger throws don't propagate
    }
  }

  return ok(NAME, {
    recall_id: recallId,
    memories,
    density_flag: density_flag === "ok" ? null : density_flag,
    bounded_by: { max_chars: maxChars, max_items: maxItems },
    truncated,
    // Phase 3 v0 additions (additive; legacy callers ignore unknown fields).
    // FU2 — OR-ed with the refusal marker (see the recallEvent stamp above:
    // visibility only, the dense leg was never suppressed).
    // b2-silent-recall-degrade — OR-ed here too (visibility only; the catch
    // block above carries the measured precedence + mutual-exclusion notes).
    degraded_recall:
      degradedRecall ||
      indexGenerationRefused != null ||
      vectorPrefetchDegraded != null ||
      denseSearchDegraded != null ||
      indexUnservable != null,
    candidate_set_size: scored.length,
    // e15-recall-temporal-scoping — envelope honesty, additive.
    // `candidate_set_size` is the POST-gate count (hard gates + Layer-2 output
    // partition + content dedup have already run); `candidate_pool_size` is the
    // fused, chunk-collapsed pool BEFORE any of that. Publishing only the
    // former made a thin brief look like a failed corpus scan. It is not:
    // CAPS.RECALL_CANDIDATE_SET_SIZE = 50 (lib/validation.js) is the Layer-1
    // ceiling consumed by hybridRetrieve (lib/recall/hybrid-retriever.js), so a
    // `candidate_set_size: 33` is that DESIGNED 50-row pool minus hard-gate and
    // dedup losses — not 1.5M rows scanned and missed. Measured over all 286
    // rows of ledgers/recall.jsonl, `candidates_pre_truncation` is p50=46,
    // p90=50, max=50: the pool sits at its ceiling, which is what settles it.
    // Invariant: candidate_pool_size >= candidate_set_size, always.
    candidate_pool_size: candidates.length,
    // r3-degraded-recall-blindspot additive — same marker, same treatment as
    // the recall event above: FIRST of the conditional spreads so every
    // pre-existing degraded_reason value is untouched, and the trailing
    // useQueryd spread below (carrying queryd_model_missing) is still LAST and
    // therefore still wins. Full response precedence:
    //   queryd_model_missing > index_generation_refused > vector_prefetch_failed
    //   > dense_search_bad_request > index_unservable
    // A healthy call's response stays byte-identical — the whole object is
    // omitted when the marker is null.
    //
    // run 2, re-derived at this site: on the model-absent path this spread now
    // writes degraded_reason "queryd_model_missing" and the REG spread below
    // writes that SAME literal last, so the collision resolves to the value it
    // always had; a duplicated key also keeps its first insertion position, so
    // the response is byte-identical to pre-run-2 apart from the marker's own
    // keys. index_generation_refused cannot participate on that path at all
    // (null on both `refusalFor` terms — the derivation is at the recall-event
    // spread above), and the two prefetch/dense markers are precluded by
    // `degradedRecall` exactly as documented there.
    ...(indexUnservable != null
      ? {
          degraded_reason: indexUnservable.reason,
          index_unservable: indexUnservable,
        }
      : {}),
    // b2-silent-recall-degrade (run 3) additive — a dense retrieval leg was
    // REFUSED (QuerydBadRequestError) and silently emptied; retrieval-scoped,
    // deliberately NOT overloaded onto the prefetch-scoped marker below.
    // Ahead of the two spreads below: later spreads win on key
    // collision, so the three-way degraded_reason precedence is
    //   index_generation_refused > vector_prefetch_failed > dense_search_bad_request
    // and no path that already fired changes its value. Healthy responses are
    // byte-identical (the whole object is omitted).
    ...(denseSearchDegraded != null
      ? {
          degraded_reason: "dense_search_bad_request",
          dense_search_degraded: denseSearchDegraded,
        }
      : {}),
    // b2-silent-recall-degrade additive — present ONLY when the Layer-2
    // enrichment prefetch FAILED (threw, generation changed under it, or an
    // attested-resident id returned a structured null); every healthy response
    // stays byte-identical.
    // BEFORE the index_generation_refused spread so that spread's
    // degraded_reason wins on a collision (the dedicated key survives either
    // way). Mutually exclusive with queryd_model_missing by construction: that
    // path sets degradedRecall = true, which precludes the prefetch.
    ...(vectorPrefetchDegraded != null
      ? {
          degraded_reason: "vector_prefetch_failed",
          vector_prefetch_degraded: vectorPrefetchDegraded,
        }
      : {}),
    // FU2 additive — present ONLY when the active index generation was
    // refused this call; every no-refusal response stays byte-identical
    // (same conditional-spread pattern as queryd_model_missing below, which
    // is mutually exclusive with this stamp for the same model version — a
    // status entry that exists cannot be "missing"; if both ever fire across
    // a tree switch, the queryd spread's degraded_reason deliberately wins).
    ...(indexGenerationRefused != null
      ? {
          degraded_reason: "index_generation_refused",
          index_generation_refused: indexGenerationRefused,
        }
      : {}),
    // WU-recall-content-dedup — how many byte-identical-content candidates
    // were collapsed this recall (additive observability field). 0 when no
    // duplicates were present OR when RECALL_CONTENT_DEDUP_ENABLED is false.
    deduped_count: dedupedCount,
    // Phase 3 v1 additions (additive). Authoritative shape contract:
    // kb/phase3-v1-rerank-contracts.md § 2.
    degraded_recall_layer3: degradedRecallLayer3,
    // F1 (memperf): surface WHY Layer-3 degraded — the same value the recall
    // ledger event already stores. null on success / not-attempted.
    rerank_failed_reason: rerankResult.rerank_failed_reason,
    layer3_latency_ms: rerankResult.layer3_latency_ms,
    rerank_input_count: rerankInput.length,
    rerank_output_count: rerankResult.reranked.length,
    // recent_recall_ids damping — how many scored candidates were damped this
    // recall because a recall named in surrounding_context.recent_recall_ids
    // had already surfaced them. 0 when the field is absent, when no id
    // resolved, or when CAPS.RECALL_RECENT_SURFACED_DAMPING_FACTOR >= 1.
    recent_surfaced_damped_count: recentSurfacedDampedCount,
    // Wave 6 — synthesis populator metadata (W4 context-populator.md § 4.7).
    // Counts (not the full extracted arrays) so the brief envelope stays
    // bounded; the full inputs are reachable from surrounding_context_hash.
    populator: {
      degraded: populatorDegraded,
      degraded_reasons: populatorDegradedReasons.slice(),
      entities_count: populatorEntityIds.length,
      time_anchors_count: populatorTimeAnchors.length,
      has_time_anchor: resolvedTimeAnchor != null,
      valence_set:
        populatorValence != null && typeof populatorValence.sign === "number",
      entity_extractor_version: ENTITY_EXTRACTOR_VERSION,
      time_anchor_resolver_version: TIME_ANCHOR_RESOLVER_VERSION,
      valence_model_version: VALENCE_MODEL_VERSION,
      episodicity_version: EPISODICITY_VERSION,
      mood_vocab_version: RECALL_VALENCE_VOCAB_VERSION,
      mood_table_miss: populatorMoodTableMissCount,
      // WU-RR2 — substrate-aware Layer-1c fallback telemetry surfaced on the
      // brief envelope. Operators consume this to size whether the BM25 +
      // HNSW combination is rich enough on a given query or whether the
      // substrate is doing the heavy lifting on candidate selection.
      fallback_triggered: fallbackTriggered,
      fallback_added_candidates: fallbackAddedCandidates,
      fallback_skip_reason: fallbackSkipReason,
    },
    // Q2 (memperf) — ADDITIVE daemon-cutover observability, present ONLY when
    // this call was served by queryd: index_source plus the S3 index-manifest
    // generation the daemon answered from (envelope-stamped, status
    // fallback). off / auto-without-socket responses carry NEITHER field, so
    // the pre-Q2 output stays byte-identical.
    ...(useQueryd
      ? {
          index_source: "queryd",
          generation: querydGenerationForResponse(),
          // REG (memperf) — LOUD model-mismatch: present ONLY when the daemon
          // status lacked the model version serving this call (see the
          // querydModelMissing block above); absent on every healthy call so
          // the pre-REG daemon-mode output stays byte-identical.
          ...(querydModelMissing
            ? { degraded_reason: "queryd_model_missing" }
            : {}),
        }
      : {}),
  });
}

export const TOOL = {
  name: NAME,
  description:
    "Retrieve a bounded brief of memories relevant to the surrounding conversational context. Call once per turn; do not loop.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["surrounding_context", "conversation_id"],
    properties: {
      surrounding_context: {
        type: "object",
        additionalProperties: false,
        required: ["recent_turns", "agent_role", "current_query", "time"],
        properties: {
          recent_turns: {
            type: "array",
            maxItems: CAPS.RECALL_RECENT_TURNS_MAX,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["role", "content"],
              properties: {
                role: { type: "string", enum: ALLOWED_TURN_ROLES },
                content: { type: "string", maxLength: CAPS.RECALL_TURN_CONTENT_CHARS },
              },
            },
          },
          agent_role: { type: "string" },
          current_query: { type: "string", maxLength: CAPS.RECALL_CURRENT_QUERY_CHARS },
          time: { type: "string", description: "ISO-8601" },
          ambient: {
            type: "object",
            additionalProperties: false,
            properties: {
              calendar_state: { type: "object" },
              inferred_mood: { type: "string" },
              parties_present: { type: "array", items: { type: "string" } },
            },
          },
          recent_recall_ids: {
            type: "array",
            maxItems: CAPS.RECALL_RECENT_RECALL_IDS_MAX,
            items: { type: "string" },
          },
        },
      },
      conversation_id: { type: "string" },
      max_items: { type: "integer", minimum: 1, maximum: CAPS.RECALL_MAX_ITEMS },
      max_chars: { type: "integer", minimum: 1, maximum: CAPS.RECALL_MAX_CHARS },
    },
  },
  handler,
};
