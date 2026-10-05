/** memory_distill_promote_fact — see kb/mcp-surface.md § memory_distill_promote_fact.
 *
 * Phase 1: the first really-callable privileged tool. Wires the five-step
 * daemon-token verification, the consumed-nonce store, the policy-events
 * audit log, and a stub ledger append. SCOPE_BLOCKED is handled at step 0
 * by dispatch.js (MEMORY_ROLE != "distillation"); this handler trusts that
 * and never re-checks role.
 *
 * Handler steps (mapped to spec § Handler steps + § Privilege levels →
 * Daemon-signed token verification):
 *   handler step 1: scope          — dispatch.js. NOT redone here.
 *   handler step 2: payload shape  — assertObjectShape + per-field asserts.
 *   handler step 3: TOKEN VERIFY (5 sub-steps):
 *       3a. compute binding_object {content_hash, source_refs_hash}
 *       3b. verifyToken           — steps 1+2 (type/freshness, signature)
 *       3c. verifyBinding         — step 3
 *       3d. checkAndConsume       — step 4 (atomic single-use)
 *       3e. source-policy consent — step 5 (walk source_refs[i] → consent_basis)
 *   handler step 4: dedupe + ledger append (Phase 1 STUB: always "promoted").
 *   handler step 5: success — emit policy.token.consumed; return envelope.
 *
 * binding_object is {content_hash, source_refs_hash} where:
 *   - content_hash      = sha256(Buffer.from(args.content, "utf8"))  // RAW UTF-8, NOT canonicalized
 *   - source_refs_hash  = sha256(canonical_json(args.source_refs))   // JCS preserves array order
 *
 * Spec ambiguity resolved: storage/sources/<source>.jsonl files do not yet
 * exist in Phase 1 (the auto-memory bridge has not landed). The handler walks
 * them anyway with fail-shut behavior: file missing or row missing → NOT_FOUND;
 * row present but lacking source_policy.consent_basis → CONSENT_BLOCKED.
 * This preserves the "Nonce stays consumed" discipline on the CONSENT_BLOCKED
 * path while letting real source ledgers slot in unchanged when they ship.
 *
 * round-15 H3 (memory-jsonl-fsync): Each fact row is fsync'd to disk
 * individually BEFORE policy.token.consumed is emitted. The parent directory is
 * also fsync'd so the new file's link (or the existing file's appended length
 * metadata) is durable across crash. Ordering reads:
 *
 *   verify → bind → consume (lock-bounded, fsync'd by nonce-store)
 *     → consent walk
 *       → ledger append + file-fsync + dir-fsync
 *         → policy.token.consumed (only after ledger durability)
 *
 * "consume-then-append (with fsync narrowing the window) and emit consumed
 * AFTER the fsync succeeds" is the best we can do without nested locks across
 * the MCP handler + ledger file — and consumed-iff-committed nested locking is
 * explicitly rejected in kb/mcp-surface.md, in the paragraph beginning
 * "Rationale: consumed-on-attempt-at-step-4 is the only viable order under a
 * single critical section" (l16: was cited as :227, which had drifted onto the
 * preceding paragraph). Residual: if writeSync /
 * fsyncSync fail AFTER checkAndConsume succeeds, the nonce is burned but no
 * fact row exists AND policy.token.consumed is NOT emitted. Operator action:
 * mint a fresh token via the supervisor and retry. This trades audit
 * completeness for storage durability — preferable because a missing
 * "consumed" event is operator-detectable (minted-without-consumed gap) while
 * a torn fact-row is silently corrupted data.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ok, error as errEnv, serverTs } from "../envelope.js";
import { ERROR_CODES, ToolError } from "../error-codes.js";
import {
  assertEnum,
  assertNonEmptyString,
  assertObject,
  assertObjectShape,
  assertOptionalStringArray,
  canonicalJson,
  canonicalJsonSha256Hex,
  CAPS,
  CONTENT_MAX_CHARS,
} from "../validation.js";
import {
  loadSigningKey,
  verifyToken,
  verifyBinding,
} from "../daemon-token.js";
import { checkAndConsume } from "../nonce-store.js";
import { appendPolicyEvent } from "../policy-events.js";
import { MEMORY_ROOT, STORAGE_DIR, memoryLedgerPath } from "../config.js";
// loadSourceRow streams the source ledger instead of materializing it. The
// module is stdlib-only (node:fs + node:string_decoder), so no import cycle.
import {
  streamLedgerLines,
  ledgerSizeOrZero,
} from "../synthesis/_ledger-stream.js";
// l14-embed-callers-migrate — the promote-time embed runs against the LOCAL
// Qwen3 server (full 4096-dim, no cloud round-trip), not gemini-client.
//
// taskType -> isQuery MAPPING (established from call sites in this tree, NOT
// from local-embedder-client.js's "SHAPE MIRROR" comment — the signatures
// differ: gemini takes {text,taskType,dims,source}, local takes {text,isQuery}):
//   - mcp/lib/tools/recall.js, the local-query-embed branch's
//     `embedSingle({ text: localQueryText, isQuery: true })` — a recall QUERY
//   - daemons/watermark.js, `localEmbedBatch({ items, isQuery: false })` —
//     ingest DOCUMENTS
// The promote handler embeds a fact BEING WRITTEN to the ledger — a document —
// so the former RETRIEVAL_DOCUMENT task type maps to isQuery:false.
import { embedSingle } from "../local-embedder-client.js";
// Telemetry parity: gemini-client's embedSingle recorded embed-cost inline;
// local-embedder-client.js has no such call.
// Without this wrapper the source:"promote-fact" counter surfaced through
// memory_connectors_list -> embed-cost.snapshotCounters would silently drop to
// zero and read as "no promotes happening". The model key it records moves
// from "gemini-embedding-001" to CAPS.ACTIVE_EMBED_MODEL_VERSION, which has no
// entry in embed-cost's price table and therefore estimates $0 — correct for a
// locally hosted embedder (the `return { input_per_1k_usd: 0, output_per_1k_usd: 0 }`
// fallthrough at the end of _priceForModel in
// mcp/lib/observability/embed-cost.js).
import { wrapEmbedSingle } from "../observability/embed-cost.js";
import { l2NormAssert } from "../vector-math.js";
import { loadIndices, scheduleSaveIndices } from "../recall/index-cache.js";
// F1 first-run — read-only import: the queryd mode decision is the herd-ban
// authority (a daemon-mode client must never deserialize an index in-process),
// so standaloneLexicalFirstRun() consults it BEFORE touching the index tree.
import { resolveQuerydMode } from "../recall/queryd-client.js";
// F1 first-run — read-only import: the parse + shape check of the generation
// manifest (one small-file read, never a member byte). The first-run predicate
// screens the on-disk tree through it before any index is deserialized.
import { readActiveManifest } from "../recall/index-manifest.js";
import {
  scoreCandidate,
  buildSalienceFeaturesBlock,
  normalizeSourceEvent,
  extractAttributionFromSourceRow,
} from "../ingest/salience.js";
import { ATTRIBUTION_KEYS as ALLOWED_ATTRIBUTION_KEYS } from "../ingest/_attribution-keys.js";
// F-SYN-INTEGRATION-CASCADE-STAMPS-ENTITIES — wire the v0 entity-extractor
// at the single promote chokepoint (appendFactRow). The extractor is pure /
// synchronous (no async deps; no I/O), so the original substrate-tier
// objection to placing it here ("appendFactRow is purely a writer with no
// async dependencies") does not apply. Centralizing in appendFactRow means
// BOTH the MCP handler PROMOTE path AND the watermark promoteSourceRow
// caller stamp features.entities + features.entity_extractor_version on the
// row without each caller having to thread a separate synth_features arg.
// The recall-time consumer (recall.js scoringContext.entities) reads the
// SAME canonical_id list the extractor produced; the symmetric-extractor
// invariant (I1↔I2) holds because it is literally one module call.
import {
  extractEntities,
  buildCanonicalId,
  ENTITY_SOURCE_SCOPES,
  ENTITY_EXTRACTOR_VERSION,
} from "../synthesis/entity-extractor.js";
// F-SYN-INTEGRATION-CASCADE-STAMPS-EPISODICITY — Wave 6 integration. The
// episodicity scorer is the W5 substrate (pure, sync, hermetic — no I/O, no
// clock, no random); the cascade stamps it at the single PROMOTE chokepoint
// (appendFactRow) so every promoted fact carries features.episodicity as a
// scalar ∈ [0,1] and features.episodicity_version pins the scorer revision
// for drift detection. Read order: AFTER entity stamping so the scorer's
// `entity_generality` input — derived from features.entities — has the
// entity list available. Defensive try/catch keeps the cascade durable: a
// scorer throw degrades features.episodicity to null and the row still
// promotes (symmetric to the W3 entity-extractor degrade discipline).
import {
  computeFromFeatures,
  EPISODICITY_VERSION,
} from "../synthesis/episodicity-scorer.js";
// WORKUNIT A-promote-projection — promote-time feature completeness. Four
// additive stamps, each CAPS-gated, run on every NEW fact at this single
// chokepoint (both MCP + watermark paths route here). All are pure / sync /
// hermetic and defensively try/catch'd so a throw degrades the field but NEVER
// breaks the durable ledger append (mirrors the W3/W6 cascade-stamp pattern).
//
//   (1) features.valence — the structured {sign, magnitude, source,
//       model_version} ValenceValue object from scoreValence(content). Stamped
//       BEFORE episodicity so computeFromFeatures has valence.magnitude. The
//       index/scorer scalar is projected via factValenceScalar (the SINGLE
//       projection shared with index-cache.js + updateIndicesForFact).
//   (2) gazetteer entities — closed-set kb_lookup recognizer run additively
//       after the structural extractor; merged into features.entities.
//   (3) identity keys forwarded from the source event onto features.thread_keys
//       so the thread / project aggregators can bucket NEW facts.
//   (4) top-level `ts` mirror of created_at so the aggregators' ts guard passes.
//   (+) degraded-extraction sentinels — *_version always stamped (even on a
//       scorer throw) + features.synth_degraded.reasons[] distinguishes
//       "scorer threw" from "genuinely empty".
import {
  scoreValence,
  factValenceScalar,
  MODEL_VERSION as VALENCE_MODEL_VERSION,
} from "../synthesis/valence-scorer.js";
import { extractGazetteerEntities } from "../synthesis/gazetteer.js";
// WU-forward-conversation-stamp — forward-only conversational provenance. At
// promote time we derive "daemon:thread:<bucket_key>" from the in-scope source
// row (watermark: `event`; MCP: `firstSourceRow`) and stamp it onto
// provenance.conversation_id, which appendFactRow already copies verbatim and
// recall/context-prefix.js already reads. Defensive: a null return (no
// derivable thread key, malformed row) leaves the field null exactly as before.
// Thesis #1 holds: this only shapes NEW rows; no existing row is touched.
import { deriveConversationId } from "../synthesis/conversation-stamp.js";
// WU2-inline-embed-and-remove-gemini-quota-machinery removed the
// enqueueEmbedJob import + the async embed-queue enqueue. The cascade now
// embeds inline via the local server; on a local-server outage the watermark
// daemon promotes with embedding=null and records the fact id to the simple
// re-embed sweep file (daemons/watermark.js appendReEmbedSweep) — no
// single-producer queue, no backfill worker.

const NAME = "memory_distill_promote_fact";

// l14-embed-callers-migrate — see the local-embedder-client import above. The
// wrapper only calls embed-cost.recordEmbedCall and then delegates verbatim
// (see wrapEmbedSingle in mcp/lib/observability/embed-cost.js): the return value and any
// thrown LocalEmbedUnavailableError pass through untouched, so the handler's
// existing bare catch degrades exactly as it did on a Gemini outage.
const trackedEmbedSingle = wrapEmbedSingle(embedSingle, {
  source: "promote-fact",
  model: CAPS.ACTIVE_EMBED_MODEL_VERSION,
});

// Per-call caps. CONTENT_MAX_CHARS is the authoritative export from
// validation.js (frozen to 16384 in kb/mcp-surface.md § Caps; do not re-define
// here). SOURCE_REFS_MAX_PHASE1 is local because the spec § Caps does not
// allocate it a symbolic name — input-schema-only.
const SOURCE_REFS_MIN = 1;
const SOURCE_REFS_MAX_PHASE1 = 16; // spec input schema: source_refs is 1..16
const CONFIDENCE_ENUM = ["high", "medium", "low", "pre_distilled"];

// Default-OFF rollout gate for keeping the lexical index warm when embedding
// fails. Read on every promotion so long-lived daemon processes can change the
// flag without re-importing this module.
function bm25DecoupleEmbedFlagOn() {
  return (
    process.env.MEMORY_BM25_DECOUPLE_EMBED === "1" ||
    process.env.MEMORY_BM25_DECOUPLE_EMBED === "true"
  );
}

// F1 first-run — the ONE shared "standalone install with no vector index"
// predicate. It is what lets memory_put work without configuration
// (tools/put.js putEnabled) and what lets an operator put be lexically indexed
// at write time (appendOperatorFact below) so recall's existing lexical-only
// path can serve it.
//
// The answer is decided from the ON-DISK artefacts under
// <MEMORY_ROOT>/indices/<active model>, never from the size of whatever index
// happens to be loaded. loadIndices does not throw on a refused or unreadable
// generation — it serves EMPTY indices and reports the fault in
// generation_refused — so "the loaded HNSW is empty" alone would call a
// configured install with a damaged index a first run. The rule, in order:
//
//   1. Herd ban: a queryd client (resolveQuerydMode() === "daemon") is never a
//      first run, and this is checked FIRST so such a process never stats,
//      reads or deserializes the index tree on account of this predicate.
//   2. No index directory for the active model at all (ENOENT) is a first run;
//      nothing is loaded. Any other stat error is NOT a first run.
//   3. A manifest that exists but cannot be read, parsed or shape-checked is
//      NOT a first run.
//   4. No manifest: any hnsw.bin, hnsw.bin.meta.json or retained "*.gen-*"
//      member on disk is NOT a first run (an unpublished or legacy vector
//      index). A tree holding only the WAL and/or a BM25 file passes.
//   5. A manifest: it must bind an EMPTY vector index — no hnsw member, or one
//      whose recorded size is within FIRST_RUN_EMPTY_HNSW_MAX_BYTES and equals
//      the size on disk; a sidecar, when bound, must be small, match its
//      recorded size and carry an empty id map; the retained previous
//      generation must be empty by the same size bound. A size mismatch (a
//      truncated member), a parse error or any stat/read error is NOT a first
//      run. This keeps a first run alive after the install publishes its OWN
//      generation (the first index flush writes a manifest plus an empty
//      hnsw.bin) and across a restart.
//   6. Only a tree that passed 4 or 5 — proven tiny by stat — is loaded, and
//      it is a first run iff the load reports generation_refused == null and
//      the HNSW (base plus WAL replay) holds zero vectors.
//
// So SCOPE_BLOCKED for a multi-GB, truncated or unreadable index costs a few
// stats and at most two small-file reads; no such index is ever deserialized
// here. Everything is inside one try/catch: any throw answers false, i.e. the
// pre-F1 behaviour — put dark, BM25 coupled to a successful embed.
//
// A configured install is unaffected: with queryd serving, or once any vector
// has been published or journalled for the active model, this is false and
// every gate that consults it collapses to its previous expression.
//
// The empty native hnsw.bin measured 96 bytes; a single 4096-dim vector is
// larger than this bound in either backend's format.
const FIRST_RUN_EMPTY_HNSW_MAX_BYTES = 4096;
const FIRST_RUN_EMPTY_HNSW_META_MAX_BYTES = 64 * 1024;
const FIRST_RUN_HNSW_FILE = "hnsw.bin";
const FIRST_RUN_HNSW_META_FILE = "hnsw.bin.meta.json";

export async function standaloneLexicalFirstRun() {
  try {
    if ((await resolveQuerydMode()) === "daemon") return false;
    const dir = join(MEMORY_ROOT, "indices", CAPS.ACTIVE_EMBED_MODEL_VERSION);
    try {
      if (!statSync(dir).isDirectory()) return false;
    } catch (e) {
      // No index tree at all is the fresh-checkout state; nothing to load.
      return e != null && e.code === "ENOENT";
    }
    // Stat screen: answers false for a large, truncated or unreadable tree
    // BEFORE anything is deserialized (throws are caught below => false).
    if (!firstRunTreeIsEmptyOnDisk(dir)) return false;
    const loaded = loadIndices(CAPS.ACTIVE_EMBED_MODEL_VERSION);
    return loaded.generation_refused == null && loaded.hnsw.size() === 0;
  } catch {
    return false;
  }
}

// statSync that maps "absent" to null and rethrows everything else, so an
// unreadable path fails the predicate closed instead of reading as absent.
function firstRunStatOrNull(path) {
  try {
    return statSync(path);
  } catch (e) {
    if (e != null && e.code === "ENOENT") return null;
    throw e;
  }
}

function firstRunEmptyHnswRecord(member) {
  return member == null || member.size <= FIRST_RUN_EMPTY_HNSW_MAX_BYTES;
}

// Steps 3-5 of the rule above. Returns true only for a tree whose on-disk
// artefacts prove there is no vector index; THROWS on any unexpected stat or
// read error (the caller's catch turns that into "not a first run").
function firstRunTreeIsEmptyOnDisk(dir) {
  const { manifest, error } = readActiveManifest(dir);
  if (error != null) return false;
  const hnswPath = join(dir, FIRST_RUN_HNSW_FILE);
  const metaPath = join(dir, FIRST_RUN_HNSW_META_FILE);

  if (manifest == null) {
    if (firstRunStatOrNull(hnswPath) != null) return false;
    if (firstRunStatOrNull(metaPath) != null) return false;
    return !readdirSync(dir).some((name) => name.includes(".gen-"));
  }

  const { hnsw, hnsw_meta: meta } = manifest.members;
  if (hnsw == null) {
    // A manifest that binds no vector member next to vector files it does not
    // name is not a state a first run produces.
    if (meta != null) return false;
    if (firstRunStatOrNull(hnswPath) != null) return false;
    if (firstRunStatOrNull(metaPath) != null) return false;
  } else {
    if (!firstRunEmptyHnswRecord(hnsw)) return false;
    const st = firstRunStatOrNull(hnswPath);
    if (st == null || !st.isFile() || st.size !== hnsw.size) return false;
    if (meta != null) {
      if (meta.size > FIRST_RUN_EMPTY_HNSW_META_MAX_BYTES) return false;
      const mst = firstRunStatOrNull(metaPath);
      if (mst == null || !mst.isFile() || mst.size !== meta.size) return false;
      const sidecar = JSON.parse(readFileSync(metaPath, "utf8"));
      if (
        sidecar == null ||
        !Array.isArray(sidecar.id_map) ||
        sidecar.id_map.length !== 0 ||
        sidecar.nextId !== 0
      ) {
        return false;
      }
    }
  }
  if (manifest.previous != null) {
    if (!firstRunEmptyHnswRecord(manifest.previous.members.hnsw)) return false;
  }
  return true;
}

// v3-ledger-embedding-reroute — default-OFF revert switch for stamping the FULL
// 4096-dim embedding onto the ledger fact row. Default (unset) is the SHIPPED
// behavior: the vector does NOT go on the row; it is carried out-of-band by
// updateIndicesForFact -> scheduleSaveIndices -> appendWalRecord (fsync'd) and
// replayed into the HNSW by index-cache.js. Setting
// MEMORY_LEDGER_ROW_EMBEDDING_4096=1 restores the legacy inline-on-the-row
// shape byte-for-byte — the operator's zero-code, zero-deploy revert.
//
// Read on every promotion (a function, NOT a module-level const) for the same
// reason as bm25DecoupleEmbedFlagOn above: long-lived daemon processes must be
// able to flip it without re-importing this module.
function ledgerRowEmbedding4096FlagOn() {
  return (
    process.env.MEMORY_LEDGER_ROW_EMBEDDING_4096 === "1" ||
    process.env.MEMORY_LEDGER_ROW_EMBEDDING_4096 === "true"
  );
}

// Consent rules from kb/ingestion.md § Consent-aware promotion. Phase 1 reads
// only this field off the source-ledger row; the salience-weighting layer
// (ranking, retention cap, quote-suppression) is downstream.
const PROMOTION_ELIGIBLE_BASES = new Set([
  "first_party",
  "third_party_inferred",
  "third_party_explicit",
]);

// Paths sourced from lib/config.js (env-overridable for hermetic tests).
// STORAGE_SOURCES_DIR retains the legacy local-const name; the value resolves
// to STORAGE_DIR + "/sources" under every override path.
const STORAGE_SOURCES_DIR = join(STORAGE_DIR, "sources");
const LEDGER_PATH = memoryLedgerPath();

// ---------------------------------------------------------------------------
// W1-CCS — F-CCS-CASCADE-row-parties-as-entities helpers.
//
// Source-aware mapping from a raw row.parties[] string to a structural entity
// shape suitable for features.entities[]. Reuses slugify + buildCanonicalId
// from the entity-extractor substrate so the canonical_id formation matches
// entity-schema §5.2 verbatim (no second slugify implementation lives in this
// file). Returns null when the source-scope is not in the closed
// ENTITY_SOURCE_SCOPES enum (e.g. "codex-cli" at v0; "whatsapp" prior to its
// admission to the enum), when the party string is unusable (empty / null),
// or when the slug pipeline drains. Silent skip per spec discipline:
// "false-conflate poisons the predicate index permanently".
//
// Per kb/entity-schema.md §5.3 (surface derivation, AUTHORITATIVE):
//   - imessage          person  ← contact handle string verbatim (display
//                                 name not available at v0 — substrate
//                                 ships without the handle directory).
//   - chat-claude-code  person  ← role marker 'user' / 'assistant' (the
//                                 closed kind enum has no 'role'; person is
//                                 the right kind per §3 — "human or
//                                 person-like party (handle, contact,
//                                 sender)"). gh:<login> on github-events
//                                 follows the same idea.
//   - git-log           person  ← author-email IS the surface verbatim.
//   - github-events     person  ← actor.login (strip 'gh:' connector prefix
//                                 when the connector wrote it).
//   - screentime        person  ← "user" sentinel (the operator).
//
// The "role" verbiage in the workunit prompt is exposition; the closed kind
// enum (entity-schema §3 + entity-extractor ENTITY_KINDS) does NOT include
// "role". person:chat-claude-code:user is the schema-conformant
// representation and matches the "person-like party (handle, contact,
// sender)" person-kind definition. Backwards-compat: rows promoted before
// this stamp lands have features.entities WITHOUT party-derived ids; recall
// reads "no overlap signal" as neutral and the row continues to score.
function buildPartyEntity(party, source) {
  if (typeof party !== "string") return null;
  const trimmed = party.trim();
  if (trimmed.length === 0) return null;

  // Source-scope gate: ENTITY_SOURCE_SCOPES is the closed enum; anything
  // outside it would throw inside buildCanonicalId. We catch that as a silent
  // skip (degrade) — the cascade hot path stays durable.
  if (!ENTITY_SOURCE_SCOPES.includes(source)) return null;

  // Per-source normalization. Each rule reduces the raw party string to the
  // surface that slugify() will canonicalize. The transformations are
  // intentionally minimal — slugify handles case folding, ASCII fold, and
  // separator collapse uniformly.
  let surface = trimmed;
  if (source === "github-events" && trimmed.startsWith("gh:")) {
    // The github-events connector writes parties as "gh:<login>" (a connector
    // prefix to disambiguate from "user"). Strip the prefix so the surface
    // matches the spec's `actor.login` derivation.
    surface = trimmed.slice(3);
    if (surface.length === 0) return null;
  }

  // Build the canonical_id via the substrate helper. Defensive: a slug that
  // drains (empty sentinel) throws inside buildCanonicalId; catch and skip.
  let canonical_id;
  try {
    canonical_id = buildCanonicalId({
      source,
      kind: "person",
      text: surface,
    });
  } catch {
    return null;
  }

  return {
    kind: "person",
    canonical_id,
    surface,
    source_scope: source,
    evidence: "handle",
    confidence: 1.0,
    extractor_version: ENTITY_EXTRACTOR_VERSION,
    span: null,
    stamped_by: "cascade:row-parties",
  };
}

// ---------------------------------------------------------------------------
// WORKUNIT A-promote-projection — identity-key extraction helper.
//
// Pull the closed aggregator-relevant identity key set off a raw source-ledger
// row so appendFactRow can forward it onto features.thread_keys. The keys live
// in the row's raw_content object (chat_guid / chat_identifier / repo_path /
// author_email / actor_login / repo / conversation_id) and, for some
// connectors, as siblings of raw_content. We probe raw_content FIRST (the
// connector-authored identity envelope) and fall back to the row sibling.
//
// Returns an object with ONLY string-valued keys from the closed set; an empty
// object when the row carries none. PURE / defensive — never throws (callers
// pass it straight into args.thread_keys, where appendFactRow re-validates).
// ---------------------------------------------------------------------------
const THREAD_KEY_NAMES = [
  "chat_guid",
  "chat_identifier",
  "repo_path",
  "author_email",
  "actor_login",
  "repo",
  "conversation_id",
];

function extractThreadKeysFromSourceRow(sourceRow) {
  const out = {};
  if (sourceRow == null || typeof sourceRow !== "object") return out;
  const raw =
    sourceRow.raw_content && typeof sourceRow.raw_content === "object"
      ? sourceRow.raw_content
      : null;
  for (const k of THREAD_KEY_NAMES) {
    // raw_content wins (connector-authored identity envelope); fall back to a
    // row-sibling field of the same name.
    let v = raw && typeof raw[k] === "string" ? raw[k] : null;
    if (v == null && typeof sourceRow[k] === "string") v = sourceRow[k];
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Payload validation (handler step 2)
// ---------------------------------------------------------------------------

function validateSourceRefs(refs) {
  if (!Array.isArray(refs)) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      "source_refs must be an array",
    );
  }
  if (refs.length < SOURCE_REFS_MIN) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `source_refs must contain at least ${SOURCE_REFS_MIN} entry`,
    );
  }
  if (refs.length > SOURCE_REFS_MAX_PHASE1) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `source_refs exceeds max ${SOURCE_REFS_MAX_PHASE1} entries`,
    );
  }
  refs.forEach((ref, i) => {
    assertObjectShape(ref, `source_refs[${i}]`, ["source", "source_msg_id"]);
    assertNonEmptyString(ref.source, `source_refs[${i}].source`);
    assertNonEmptyString(ref.source_msg_id, `source_refs[${i}].source_msg_id`);
  });
}

function validateProvenance(prov) {
  assertObjectShape(prov, "provenance", [
    "agent_id",
    "conversation_id",
    "confidence",
  ]);
  assertNonEmptyString(prov.agent_id, "provenance.agent_id");
  // conversation_id is nullable string per spec ("null when promoted from
  // non-chat source"). Accept null OR non-empty string; reject other types.
  if (prov.conversation_id !== null) {
    assertNonEmptyString(prov.conversation_id, "provenance.conversation_id");
  }
  assertEnum(prov.confidence, CONFIDENCE_ENUM, "provenance.confidence");
}

function validatePayload(args) {
  assertObjectShape(args, "args", [
    "source_refs",
    "content",
    "derived_from",
    "provenance",
    "confirmation_token",
  ]);
  validateSourceRefs(args.source_refs);
  assertNonEmptyString(args.content, "content", { maxChars: CONTENT_MAX_CHARS });
  assertOptionalStringArray(args.derived_from, "derived_from");
  assertObject(args.provenance, "provenance");
  validateProvenance(args.provenance);
  assertNonEmptyString(args.confirmation_token, "confirmation_token");
}

// ---------------------------------------------------------------------------
// Source-ledger consent walk (handler step 3e == verify step 5)
// ---------------------------------------------------------------------------

// Sentinel thrown out of the streamLedgerLines callback to stop the scan the
// moment the target row is found. streamLedgerLines does not offer an
// early-exit return value, but it documents that an onRow throw propagates by
// design — so a module-private Symbol is the cheapest correct stop signal, and
// catching EXACTLY it (re-throwing everything else) keeps a real bug loud.
const LOAD_SOURCE_ROW_FOUND = Symbol("loadSourceRow.found");

// Locate source_msg_id in storage/sources/<source>.jsonl. Returns the parsed
// row on success. Throws ToolError NOT_FOUND on missing file or missing row.
// Lines that fail JSON.parse are skipped silently (mid-file corruption is a
// connector concern; the spec leaves Phase 1's read-side strictness loose so
// long as the consent-bearing row, when present, is read correctly).
//
// STREAMED, NOT WHOLE-FILE READ. The previous body did
// `readFileSync(path, "utf8")` + `split("\n")` + a linear scan. Measured this
// session on a 52,855,512-byte / 50,000-row fixture driven through the real
// TOOL.handler: the whole-file body grew heapUsed by 78,660,360 B (1.488 heap
// bytes per file byte); the streaming body below is budgeted and asserted under
// 0.75 B/B by mcp/test/remaining-stringcap-sites.test.mjs T-B5. It is ALSO a
// latent instance of the ERR_STRING_TOO_LONG class — the largest file this can
// open, storage/sources/mail.jsonl, measured 349,643,964 B against a
// 536,870,888-byte cap (0.651x), i.e. under the cap today and growing.
//
// RETENTION: exactly one row — the match. Never a line array, never a row
// array. Every other parsed row is dropped the instant onRow returns.
function loadSourceRow(source, sourceMsgId) {
  const safeSource = source.replace(/[^A-Za-z0-9._-]/g, "");
  if (safeSource === "" || safeSource !== source) {
    throw new ToolError(
      ERROR_CODES.NOT_FOUND,
      `source "${source}" is not a recognized source-ledger name`,
    );
  }
  const path = join(STORAGE_SOURCES_DIR, `${safeSource}.jsonl`);
  if (!existsSync(path)) {
    throw new ToolError(
      ERROR_CODES.NOT_FOUND,
      `source_refs entry resolved to missing source ledger: ${safeSource}`,
    );
  }
  // RETENTION BOUND: exactly one row. `found` is the only row reference that
  // outlives its onRow call; unparseable lines are skipped by the primitive,
  // preserving the tolerance the split/parse loop had.
  let found = null;
  let counts;
  try {
    counts = streamLedgerLines(path, (parsed) => {
      if (parsed && parsed.source_msg_id === sourceMsgId) {
        found = parsed;
        throw LOAD_SOURCE_ROW_FOUND;
      }
    });
  } catch (e) {
    // Only OUR sentinel means "stop, we have it". Anything else is a real bug
    // (or a ToolError from deeper down) and must stay loud.
    if (e !== LOAD_SOURCE_ROW_FOUND) throw e;
  }
  // READ FAILURE IS NEVER SILENCE, AND IT IS CHECKED FIRST. streamLedgerLines
  // never throws — it reports fs errors on counts.readError and returns partial
  // counts. Without this check, and before the not-found determination below, a
  // read failure would silently become "source_msg_id not found", which
  // falsifies the consent gate: the caller would read a NOT_FOUND as "this row
  // does not exist" when the truth is "this ledger could not be read".
  //
  // `counts` is undefined only when the sentinel unwound the call — which means
  // the scan reached the target row, so there was no read failure to report.
  if (counts && counts.readError !== null) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `failed to read source ledger ${safeSource}: ${counts.readError}`,
    );
  }
  // The "(ledger empty)" exit keys on FILE SIZE 0, not on zero parsed rows,
  // because the body it replaces keyed on `raw === ""` — i.e. on an empty
  // read, i.e. on a 0-byte file. A newlines-only or all-unparseable ledger is
  // size > 0 and must still produce the PLAIN not-found message.
  if (found === null && ledgerSizeOrZero(path) === 0) {
    throw new ToolError(
      ERROR_CODES.NOT_FOUND,
      `source_msg_id ${sourceMsgId} not found in ${safeSource} (ledger empty)`,
    );
  }
  // CONSENT/AUTHORITY PATH: return the WHOLE parsed row, unreshaped. Dispatch
  // consumers read row.source_policy (the CONSENT_BLOCKED gate) and
  // row.source_policy.consent_basis (stamped durably onto the promoted fact's
  // source_refs[].consent_basis), and the first source_ref's row is retained as
  // firstSourceRow for the R25 salience cascade.
  if (found !== null) return found;
  throw new ToolError(
    ERROR_CODES.NOT_FOUND,
    `source_msg_id ${sourceMsgId} not found in ${safeSource}`,
  );
}

// Apply ingestion.md § Consent-aware promotion to a single source-ledger row.
// Returns nothing on success; throws ToolError CONSENT_BLOCKED on forbidden.
function assertSourceRowAllowsPromotion(row, source, sourceMsgId) {
  const policy = row && row.source_policy;
  if (policy == null || typeof policy !== "object" || Array.isArray(policy)) {
    throw new ToolError(
      ERROR_CODES.CONSENT_BLOCKED,
      `source_policy missing on ${source}/${sourceMsgId}; refusing to promote`,
    );
  }
  const basis = policy.consent_basis;
  if (typeof basis !== "string" || !PROMOTION_ELIGIBLE_BASES.has(basis)) {
    throw new ToolError(
      ERROR_CODES.CONSENT_BLOCKED,
      `source_policy.consent_basis "${basis}" forbids promotion`,
    );
  }
}

// ---------------------------------------------------------------------------
// Ledger append (handler step 4 — Phase 1 STUB; dedupe always "promoted")
// ---------------------------------------------------------------------------

function ensureLedgerDir() {
  const dir = dirname(LEDGER_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

// round-15 H3: open-flags + mode for fact-row appends. O_APPEND lets the
// kernel serialize concurrent writes at the byte-boundary so two privileged
// MCP handlers running in parallel cannot interleave row bytes; O_NOFOLLOW
// refuses to write through a symlink (matches nonce-store discipline);
// O_WRONLY because we only ever append. O_CREAT plumbs first-touch creation
// at mode 0o600. Subsequent opens keep whatever mode the file already has.
const LEDGER_O_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_APPEND |
  fsConstants.O_CREAT |
  fsConstants.O_NOFOLLOW;
const LEDGER_FILE_MODE = 0o600;

// round-15 H3: per-row checksum. Matches the consumed-nonces line discipline
// (mcp/lib/nonce-store.js § blake2b512TruncTo16Hex). The checksum is the
// blake2b512 of the canonical_json of the row WITHOUT its checksum field,
// truncated to 16 bytes (32 hex chars), appended as the final key. Read-side
// verification is not wired today (kb consensus: torn-line detection on
// memory.jsonl is a Phase 2 feature), but the field is present so the future
// verifier has a stable contract and so manual operator inspection can
// re-derive the checksum and confirm a row's integrity offline.
function rowChecksumHex(rowWithoutChecksum) {
  const canonical = canonicalJson(rowWithoutChecksum);
  const full = createHash("blake2b512").update(Buffer.from(canonical, "utf8")).digest();
  return full.subarray(0, 16).toString("hex");
}

// fsyncDir — open a directory in read-only mode + fsync its file descriptor.
// Without this the directory entry for the appended file (or the appended
// length metadata on the existing file) is not durable across crash on POSIX
// filesystems that journal data-and-metadata-separately (ext4 default,
// APFS-on-darwin barriers). The cost is a single sync call per ledger append;
// well-bounded inside the privileged-pipeline hot path because privileged
// calls are rare.
//
// macOS quirk: fsync on a directory is permitted but may not flush the parent
// inode all the way to platter — F_FULLFSYNC is the stronger primitive on
// HFS+/APFS. Node has no API for fcntl(F_FULLFSYNC); fsyncSync is the
// portable best-effort and is the same primitive watermark.js + nonce-store
// rely on for their file-level durability already. Better-than-nothing on
// darwin, correct on linux/bsd.
function fsyncDir(dirPath) {
  let dirFd = -1;
  try {
    dirFd = openSync(dirPath, fsConstants.O_RDONLY);
    fsyncSync(dirFd);
  } catch (err) {
    // EISDIR or EINVAL on platforms that refuse to fsync a directory: surface
    // as best-effort. The file-fsync above this call is the primary durability
    // gate; this is the metadata-link follow-up.
    if (err && err.code !== "EISDIR" && err.code !== "EINVAL") {
      throw err;
    }
  } finally {
    if (dirFd !== -1) {
      try { closeSync(dirFd); } catch {}
    }
  }
}

// appendFactRow — write the fact-kind row to the memory ledger.
//
// `consentBasisBySourceMsgId` is a Map<source_msg_id, consent_basis> populated
// by the source-policy walk in handler step 3e. Every source ref in
// args.source_refs has been validated to have a promotion-eligible
// consent_basis (per ingestion.md § Consent-aware promotion); the basis is
// forwarded into the fact-row source_refs[] so downstream salience-weighting
// (ranking damping, retention cap, no-verbatim-quoting for
// third_party_inferred) can read it without re-walking the source ledger.
// See kb/architecture.md § Memory ledger fact schema (consent_basis field).
//
// round-15 H3 (memory-jsonl-fsync):
//   1. openSync(LEDGER_O_FLAGS, 0o600) — explicit O_APPEND|O_CREAT|O_WRONLY|
//      O_NOFOLLOW (the appendFileSync helper does not let us hand back the fd
//      we need for fsync).
//   2. writeSync the canonical bytes (single syscall — kernel atomicity at
//      O_APPEND boundary).
//   3. fsyncSync(fd) — file-level durability of the bytes we just wrote.
//   4. closeSync.
//   5. fsyncDir(dirname(LEDGER_PATH)) — directory-level durability of the
//      new file entry (first append) or the appended length metadata
//      (subsequent appends). Without this, even step 3 can be lost in a
//      power-cut between the data block sync and the inode-link sync.
//
// Each step throws on failure; the caller (handler step 4) catches and emits
// INTERNAL_ERROR. The nonce is already consumed at this point — see header
// comment for the residual.
// embedOutput is one of:
//   - { ok: true, vector_4096 } -> features carries embedding_model_version =
//     ACTIVE_EMBED_MODEL_VERSION + embed_state=false, and (v3-ledger-embedding-
//     reroute) NO embedding_4096 key at all — the vector travels out-of-band via
//     the fsync'd index WAL. MEMORY_LEDGER_ROW_EMBEDDING_4096=1 restores the
//     legacy inline-on-the-row shape. The cascade's inline local-server embed
//     path (WU2).
//   - { ok: true, vector_3072, vector_mrl_renormalized } -> legacy Gemini
//     path: features carries embedding_3072 + embedding_mrl_768 +
//     embedding_model_version = GEMINI_EMBEDDING_MODEL_DEFAULT. As of
//     l14-embed-callers-migrate NO caller in this file produces this shape:
//     the MCP handler and promoteSourceRow both emit { ok:true, vector_4096 }
//     (in promoteSourceRow, the `if (embedding4096)` arm), and
//     promoteSourceRow's back-compat `else if (embeddingMrl768)` arm only
//     fires for a caller-supplied salience.embedding_mrl_768.
//     Kept for that back-compat branch and for pre-existing rows.
//   - { ok: false } -> embedding fields persisted as explicit null +
//     embed_state=true; recall detects "no embedding" structurally (null
//     embedding_4096) meanwhile. WHO RE-EMBEDS IT depends on the caller, and
//     only one caller has recovery: the watermark daemon appends the fact id
//     to the re-embed sweep file (its sole call site is appendReEmbedSweep in
//     daemons/watermark.js) and daemons/reembed-drain.mjs consumes that file.
//     The MCP handler and appendOperatorFact write NO sweep entry, so rows
//     they land on this branch are never automatically revisited.
function appendFactRow(
  args,
  promotedAt,
  consentBasisBySourceMsgId,
  embedOutput,
  salienceFeatures,
) {
  ensureLedgerDir();
  const memoryEventId = "mem_" + randomBytes(8).toString("hex");
  const features = {};
  // WORKUNIT A-promote-projection — degraded-extraction sentinel accumulator.
  // Every synthesis stamp below appends a machine-readable reason here when its
  // scorer/extractor THROWS, so a read-side consumer can distinguish "the
  // scorer ran and found nothing" (field present, empty/neutral) from "the
  // scorer threw and we degraded" (reason recorded). The block is only stamped
  // onto the row when at least one reason was recorded — a clean promote
  // carries NO synth_degraded field (byte-compatible with pre-WU rows).
  const synthDegradedReasons = [];
  // WU2-inline-embed-and-remove-gemini-quota-machinery. The embed branch is
  // three-way:
  //   ok=true + vector_4096  → embed_state=false + model_version stamped, and
  //                            (v3-ledger-embedding-reroute) NO embedding_4096
  //                            key on the row — the vector goes out-of-band to
  //                            the fsync'd index WAL and recall's overlay reads
  //                            it back. MEMORY_LEDGER_ROW_EMBEDDING_4096=1
  //                            restores the inline shape.
  //   ok=true + vector_3072  → legacy Gemini embedding_3072 + embedding_mrl_768
  //                            populated; embed_state=false.
  //   ok=false / absent      → embedding fields EXPLICITLY null,
  //                            embed_state=true. The recall additive-only
  //                            fallback gate carries the rank. Only the
  //                            watermark-daemon caller also appends a
  //                            re-embed sweep entry (drained by
  //                            daemons/reembed-drain.mjs); other callers
  //                            leave the row with no recovery marker.
  if (embedOutput && embedOutput.ok === true && Array.isArray(embedOutput.vector_4096)) {
    // WU2-inline-embed-and-remove-gemini-quota-machinery — local-backend
    // inline embed. The cascade embeds via the local Qwen3 server which
    // returns a FULL 4096-dim L2-unit vector (no MRL slice).
    //
    // v3-ledger-embedding-reroute — THE VECTOR NO LONGER GOES ON THE ROW.
    //
    // WHY: measured over the live ledger's most recent fact rows, the average
    // row is 88,347 B of which features.embedding_4096 is 87,998 B (96.59%),
    // while content averages 550 B. The ledger is ~3.06 GB growing 19-24 MB/day
    // at only ~200-400 facts/day — the growth is per-row SIZE, not volume. And
    // recall pays for it on every read: JSON.parse of a 45-row candidate set
    // costs 7.55 ms / 4,092,480 B with the vector vs 0.26 ms / 131,850 B
    // without.
    //
    // WHERE THE VECTOR ACTUALLY LIVES: this same promote path carries it
    // out-of-band. updateIndicesForFact (below) calls scheduleSaveIndices(
    // modelVersion, {bm25, hnsw}, {factId, bm25Entry, vector}), which
    // synchronously appends a crc-framed record via
    // index-wal.js appendWalRecord -> fsyncSync(fd). index-cache.js replays it
    // with hnsw.add(rec.fact_id, rec.vector), and daemon/queryd.js absorbs the
    // WAL tail on every 2 s watch tick precisely so promoted-but-not-yet-
    // published facts stay visible. The read side is already built and wired:
    // recall.js _resolveCandidateEmbedding (row vector first, else
    // hnsw.getVectorByMemoryId, dimension-guarded) and, in daemon mode, the
    // batched queryd vector_fetch prefetch behind the identical shim.
    //
    // WHAT MUST NOT CHANGE: embed_state — NOT the presence of the
    // embedding_4096 field — is the additive-fallback discriminator in
    // multi-feature-score.js (it routes to the additive-only branch only when
    // embed_state === true AND both embeddings are null AND s_emb === 0). This
    // success path keeps embed_state=false, so the discriminator cannot move.
    // Nor do we write embedding_4096 = null here: an EXPLICIT null is the
    // null-embed branch's signature (see below) and mixing the two would muddy
    // the on-disk shape and the re-embed sweep's key.
    //
    // model_version = ACTIVE_EMBED_MODEL_VERSION stays stamped and is now
    // LOAD-BEARING, not decorative: with the vector off the row, the triple
    // (embed_state === false && embedding_model_version === ACTIVE && no
    // embedding_4096 key) is the ONLY enumeration key a reconciliation sweep
    // has for "this fact's vector belongs in the 4096 index".
    //
    // REVERT: MEMORY_LEDGER_ROW_EMBEDDING_4096=1 restores the legacy inline
    // shape with zero code change and no deploy.
    if (ledgerRowEmbedding4096FlagOn()) {
      features.embedding_4096 = embedOutput.vector_4096;
    }
    features.embedding_model_version = CAPS.ACTIVE_EMBED_MODEL_VERSION;
    features.embed_state = false;
  } else if (embedOutput && embedOutput.ok === true) {
    // Legacy Gemini embed path. l14-embed-callers-migrate repointed the manual
    // memory_distill_promote_fact handler onto the local embedder, so the only
    // producer left is promoteSourceRow's caller-supplied
    // salience.embedding_mrl_768 back-compat arm (`else if (embeddingMrl768)`).
    // R25.7 CRIT-A2: vector_3072 may
    // be null on the watermark-path sync-embed integration (only the MRL-768d
    // vector is carried). Only write the field when actually present so the
    // on-disk shape stays clean.
    if (Array.isArray(embedOutput.vector_3072)) {
      features.embedding_3072 = embedOutput.vector_3072;
    }
    features.embedding_mrl_768 = embedOutput.vector_mrl_renormalized;
    features.embedding_model_version =
      CAPS.GEMINI_EMBEDDING_MODEL_DEFAULT;
    features.embed_state = false;
  } else {
    // Null-embed PROMOTE path. WU2: the cascade reaches here only on a
    // local-server outage; the row lands with explicit embedding=null +
    // embed_state=true. The recall additive-only branch carries the rank
    // meanwhile. Recovery is CALLER-DEPENDENT: on the watermark path the
    // daemon appends the fact id to the simple re-embed sweep file (NOT an
    // async queue), which daemons/reembed-drain.mjs later drains; on the MCP
    // handler / appendOperatorFact paths no sweep entry is written and the
    // row is never automatically revisited.
    features.embedding_4096 = null;
    features.embedding_3072 = null;
    features.embedding_mrl_768 = null;
    features.embedding_model_version = null;
    features.embed_state = true;
  }
  // R29.3 retired the legacy features.embedding_pending=true marker. The
  // branch above instead writes the embedding fields as EXPLICIT null with
  // embed_state=true — the explicit null IS this branch's on-disk signature
  // (see the success path's note above). Recovery is CALLER-DEPENDENT and only
  // one caller has it: the watermark daemon appends the fact id to the re-embed
  // sweep file (drained by daemons/reembed-drain.mjs). The manual MCP handler
  // and appendOperatorFact write NO sweep entry, and nothing enumerates ledger
  // rows by embed_state, so rows they land here are never automatically
  // revisited. scripts/backfill-embeddings.mjs is NOT that recovery path: it is
  // a manually-invoked Gemini-era script whose embedBatch mints a 3072-d vector
  // into the Gemini sidecar/tree, never the ACTIVE 4096-d vector this row
  // needs. See the residual note at the end of this file.
  // R25 salience block — produced by ingest/salience.js scoreCandidate on the
  // PROMOTE branch. Carries {score, components, weights_hash, version}; the
  // two zero-weighted decay-feedback grafts (last_retrieved_ts, use_count)
  // sit inside .components ready for CP-5 Trigger A's byte-idempotent weight
  // bump + replay. May be undefined when the caller chose to skip salience
  // (e.g. legacy backfill paths or first-write smoke tests) — feature stays
  // schema-compatible: omitted vs present is the only observable difference.
  if (salienceFeatures && typeof salienceFeatures === "object") {
    features.salience = salienceFeatures;
  }

  // F-SYN-INTEGRATION-CASCADE-STAMPS-ENTITIES — synthesis features stamp.
  //
  // Run the v0 entity-extractor over args.content with the row's source as
  // the canonicalization scope. The extractor is precision-first (structural
  // patterns only at v0: URLs, emails, GitHub repo paths, phone numbers,
  // file paths, hashtags) and STRICTLY synchronous / hermetic — no I/O, no
  // Date.now, no Math.random, no network. It is therefore safe to call from
  // inside the durability-critical appendFactRow.
  //
  // Defensive degradation: any throw from the extractor (unknown source
  // scope, type error, future signature drift) MUST NOT break the ledger
  // append. The fact row remains promotable with features.entities = []
  // and the recall layer treats absent entities as "no overlap signal" —
  // the additive soft feature degrades gracefully. The cascade-side
  // invariant per the F-SYN-INTEGRATION-CASCADE-STAMPS-ENTITIES node:
  // "extractor failure degrades to empty entities; embedding remains
  // multiplicative-gate-critical".
  //
  // Source-scope gating: the v0 ENTITY_SOURCE_SCOPES enum is closed
  // (imessage / git-log / github-events / screentime / chat-claude-code /
  // manual). Sources outside the enum (e.g. internal smoke-test rows that
  // use sentinel sources) would otherwise throw "unknown source"; we
  // catch and degrade rather than refuse the promote.
  const firstRef = args.source_refs && args.source_refs[0];
  const sourceForExtract =
    firstRef && typeof firstRef.source === "string" ? firstRef.source : null;
  let extractedEntities = [];
  // WORKUNIT A-promote-projection (sentinel discipline, MAP finding N2.2): the
  // extractor version is ALWAYS stamped — even when the extractor throws —
  // because ENTITY_EXTRACTOR_VERSION is a module constant that is safe to read
  // regardless of scorer state. The old code nulled it on throw, which made a
  // degraded row indistinguishable from a row stamped by a versionless legacy
  // path. Drift detection (F-SYN-OPERATIONAL-drift-detection) reads this tag to
  // schedule re-stamp passes; a null here would silently exempt the row.
  let entityExtractorVersion = ENTITY_EXTRACTOR_VERSION;
  if (sourceForExtract && typeof args.content === "string") {
    try {
      const r = extractEntities(args.content, {
        source: sourceForExtract,
        language: "en",
      });
      if (r && Array.isArray(r.entities)) extractedEntities = r.entities;
      if (r && typeof r.model_version === "string") {
        entityExtractorVersion = r.model_version;
      }
    } catch (err) {
      // Silent degrade per the integration node's invariant.
      // stderr breadcrumb so operators can detect a regression.
      console.error(
        `appendFactRow: entity extraction failed (degrading to features.entities=[]): ${err && err.message ? err.message : String(err)}`,
      );
      extractedEntities = [];
      // Version stays at the constant (see above); record the degrade reason.
      synthDegradedReasons.push("entity_extractor_threw");
    }
  }
  features.entities = extractedEntities;
  // Always stamp the version (sentinel discipline above).
  features.entity_extractor_version = entityExtractorVersion;

  // WORKUNIT A-promote-projection — gazetteer (closed-set) entities. Runs
  // additively AFTER the structural extractor over the SAME source scope. The
  // gazetteer recognizes operator-known named entities in free prose (project
  // names, contacts, hardware) that the structural patterns cannot see, and
  // emits them with evidence='kb_lookup'. Merged by canonical_id so a surface
  // that BOTH the structural pass and the gazetteer matched collapses to one
  // entity (structural already present wins; gazetteer only adds NEW ids).
  //
  // Default-ON, CAPS-gated (CASCADE_GAZETTEER_ENABLED). Pure / sync / hermetic
  // (no I/O — the seed is a frozen module constant). Defensive try/catch: a
  // throw degrades to "no gazetteer adds" and the row still promotes with the
  // structural entities standing alone.
  //
  // Ordering: BEFORE the row-parties stamp and BEFORE episodicity so the
  // scorer's entity_generality input sees the full merged entity set.
  if (CAPS.CASCADE_GAZETTEER_ENABLED === true) {
    try {
      if (sourceForExtract && typeof args.content === "string") {
        const g = extractGazetteerEntities(args.content, {
          source: sourceForExtract,
        });
        const gazEntities = g && Array.isArray(g.entities) ? g.entities : [];
        if (gazEntities.length > 0) {
          const existingIds = new Set(
            (features.entities || [])
              .filter((e) => e && typeof e.canonical_id === "string")
              .map((e) => e.canonical_id),
          );
          for (const ge of gazEntities) {
            if (!ge || typeof ge.canonical_id !== "string") continue;
            if (existingIds.has(ge.canonical_id)) continue;
            existingIds.add(ge.canonical_id);
            features.entities.push(ge);
          }
        }
      }
    } catch (err) {
      console.error(
        `appendFactRow: gazetteer extraction failed (degrading; structural entities stand alone): ${err && err.message ? err.message : String(err)}`,
      );
      synthDegradedReasons.push("gazetteer_threw");
    }
  }

  // W1-CCS — F-CCS-CASCADE-row-parties-as-entities.
  //
  // Propagate the raw row's parties[] (when present) into features.entities
  // as kind='person' entities scoped to the row's source. This is the
  // cheap structural-feature win called out by the cascade node: every
  // promoted fact already has a known party set (the iMessage handle, the
  // git author email, the github actor login, the chat-claude-code role
  // markers). Without this stamp, features.entities is populated ONLY by
  // text-pattern extraction over args.content, which leaves rows like a
  // tapback or a one-word iMessage reply with an empty entity list — even
  // though the operator-to-contact predicate ("conversations between me
  // and Robin") is the entire reason the row was promoted.
  //
  // Source: the parties list is read off args.parties (a NON-validated
  // pass-through field that the MCP handler and promoteSourceRow populate
  // from firstSourceRow.parties / event.parties respectively). The
  // appendFactRow signature stays positional — callers that omit
  // args.parties degrade gracefully (no parties stamped; existing entity
  // stamps stand alone).
  //
  // Ordering: runs AFTER entity extraction so the dedupe by canonical_id
  // (skip-if-already-present) sees the structurally-extracted entities and
  // does not double-stamp them. Runs BEFORE the row-ts stamp + episodicity
  // stamp so the scorer's entity_generality input includes the
  // party-derived ids.
  //
  // Defensive degradation (mirrors W3 / W6 / row-ts pattern): any throw
  // here MUST NOT break the ledger append. On throw, features.entities is
  // left in whatever state the extractor branch produced and the row
  // continues to promote.
  try {
    const parties = Array.isArray(args.parties) ? args.parties : [];
    if (parties.length > 0) {
      // Build a Set of canonical_ids already on the row to dedupe.
      const existingIds = new Set(
        (features.entities || [])
          .filter((e) => e && typeof e.canonical_id === "string")
          .map((e) => e.canonical_id),
      );
      for (const p of parties) {
        const partyEntity = buildPartyEntity(p, sourceForExtract);
        if (!partyEntity) continue;
        if (existingIds.has(partyEntity.canonical_id)) continue;
        existingIds.add(partyEntity.canonical_id);
        features.entities.push(partyEntity);
      }
    }
  } catch (err) {
    console.error(
      `appendFactRow: row-parties entity stamp failed (degrading; row still promotes): ${err && err.message ? err.message : String(err)}`,
    );
  }

  // W1-CCS — F-CCS-CASCADE-row-ts-as-anchor.
  //
  // Stamp the row's promote-time `promotedAt` ISO timestamp as a structural
  // absolute time anchor at position 0 of features.time_anchors. Rationale:
  // the v0 text-extracted time-anchor-resolver returns empty for the vast
  // majority of technical content (commit subjects, code snippets, ScreenTime
  // app names), which leaves features.episodicity at a uniform 0.11-0.13
  // floor because the scorer's time_specificity input has nothing to read.
  // Every promoted fact has, at minimum, a known wall-clock moment of
  // promotion: that anchor is provenance, not extraction, so it gets the
  // structural:true flag and a stamped_by="cascade:row-ts" breadcrumb so
  // downstream readers (recall episodicity-twin, drift detection) can
  // distinguish structural anchors from text-extracted ones.
  //
  // Ordering: this stamp runs AFTER entity stamping and BEFORE the
  // episodicity stamp so the scorer's `time_specificity` input — derived
  // from features.time_anchors — has the structural anchor available.
  //
  // Position: unshift to position 0 so subsequent text-extracted anchors
  // (when the resolver lands on the cascade path in a future wave) append
  // after the structural one and the structural is always the head.
  //
  // Defensive degradation (mirrors the W3 / W6 cascade-stamping pattern):
  // any throw here MUST NOT break the ledger append. On throw the
  // time_anchors block is left in whatever state the entity-extractor
  // branch produced (typically absent) and the row still promotes.
  try {
    if (promotedAt && typeof promotedAt === "string") {
      features.time_anchors = Array.isArray(features.time_anchors)
        ? features.time_anchors
        : [];
      features.time_anchors.unshift({
        kind: "absolute",
        instant_iso: promotedAt,
        raw_phrase: null,
        structural: true,
        stamped_by: "cascade:row-ts",
      });
    }
  } catch (err) {
    // stderr breadcrumb mirrors the W3 / W6 degrade branches.
    console.error(
      `appendFactRow: row-ts time-anchor stamp failed (degrading; row still promotes): ${err && err.message ? err.message : String(err)}`,
    );
  }

  // W2-CCS — F-CCS-CASCADE-structured-features-merge.
  //
  // When the underlying source-ledger row carries a connector-emitted
  // structured_features payload (per F-CCS-FOUNDATION-structured-features-
  // schema), merge it into the fact's features at promote time. The merge
  // rule is union-with-precedence: structured wins on canonical_id collision
  // for entities; structured wins on (kind, parsed.iso ?? raw_phrase)
  // collision for time_anchors. Text-extracted additions are preserved.
  //
  // Backwards-compat: missing args.structured_features → text-only path is
  // byte-identical to today's cascade output (no-op for pre-upgrade rows).
  //
  // Defensive degradation (mirrors W3 / W6 / row-parties pattern): any
  // throw from the merge MUST NOT break the ledger append. On malformed
  // structured_features (non-object, missing required keys, wrong types)
  // we log a stderr breadcrumb and the text-extractor path stands alone.
  // The fact row remains durable; the operator can re-extract via a future
  // drift-detector pass once the connector is fixed.
  //
  // Ordering: runs AFTER text entity extraction AND row-parties stamping
  // (so the merge map sees the full text-extracted set for dedupe) AND
  // AFTER row-ts time_anchor stamping (so the time_anchors merge sees the
  // structural anchor for dedupe), but BEFORE episodicity scoring so the
  // scorer's entity_generality / time_specificity inputs include the
  // merged set.
  try {
    const sf = args.structured_features;
    if (sf != null && typeof sf === "object" && !Array.isArray(sf)) {
      // Entity merge — structured wins on canonical_id collision.
      const structuredEntities = Array.isArray(sf.entities) ? sf.entities : [];
      if (structuredEntities.length > 0) {
        const textEntities = Array.isArray(features.entities)
          ? features.entities
          : [];
        const byId = new Map();
        for (const se of structuredEntities) {
          if (
            se &&
            typeof se === "object" &&
            typeof se.canonical_id === "string" &&
            se.canonical_id.length > 0
          ) {
            byId.set(se.canonical_id, se);
          }
        }
        for (const te of textEntities) {
          if (
            te &&
            typeof te === "object" &&
            typeof te.canonical_id === "string" &&
            te.canonical_id.length > 0 &&
            !byId.has(te.canonical_id)
          ) {
            byId.set(te.canonical_id, te);
          }
        }
        features.entities = [...byId.values()];
      }
      // Time-anchor merge — dedupe by (kind, parsed.iso ?? raw_phrase ??
      // instant_iso). The cascade's row-ts stamp uses {kind:"absolute",
      // instant_iso: promotedAt}; connector emits often use
      // {kind:"absolute", parsed:{iso:...}} per the structured-features
      // schema. Either form collapses on a normalized key.
      const structuredAnchors = Array.isArray(sf.time_anchors)
        ? sf.time_anchors
        : [];
      if (structuredAnchors.length > 0) {
        const textAnchors = Array.isArray(features.time_anchors)
          ? features.time_anchors
          : [];
        const dedupeKey = (a) => {
          if (!a || typeof a !== "object") return "";
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
        for (const ta of textAnchors) {
          const k = dedupeKey(ta);
          if (k !== "" && !byKey.has(k)) byKey.set(k, ta);
        }
        features.time_anchors = [...byKey.values()];
      }
      // source_specific is NOT merged at v0 per spec §6.5; intentionally
      // skip. Downstream consumers may project off row.structured_features
      // .source_specific directly without going through fact.features.
    }
  } catch (err) {
    // stderr breadcrumb; text-only path is the safe degrade.
    console.error(
      `appendFactRow: structured_features merge failed (degrading to text-only path; row still promotes): ${err && err.message ? err.message : String(err)}`,
    );
  }

  // WORKUNIT A-promote-projection — VALENCE stamp.
  //
  // Stamp features.valence as the FULL structured ValenceValue OBJECT
  // {sign, magnitude, source, model_version} produced by scoreValence(content).
  // This is the row's narrative-mood signal. Two consumers read it:
  //   - the episodicity scorer (computeFromFeatures, run BELOW) reads
  //     features.valence.magnitude as its narrative_valence_magnitude input —
  //     so this stamp MUST PRECEDE the episodicity stamp (MAP finding N2.5).
  //   - the recall index/scorer layer reads a SCALAR ∈ [-1,+1]; that scalar is
  //     projected by factValenceScalar (the SINGLE projection shared by
  //     index-cache.js + updateIndicesForFact) at index time, NOT stored as a
  //     second on-row field — the object is the authoritative on-disk shape.
  //
  // Always stamp features.valence_model_version (the module constant) — even on
  // a scorer throw — so drift detection can see the scorer revision regardless
  // of outcome (sentinel discipline, MAP finding N2.2).
  //
  // Default-ON, CAPS-gated (CASCADE_VALENCE_STAMP_ENABLED). Pure / sync /
  // hermetic. Defensive try/catch: a throw leaves features.valence = null (the
  // neutral "absent" projection — valenceCompat reads null as no-signal) and
  // records a degrade reason; the row still promotes.
  if (CAPS.CASCADE_VALENCE_STAMP_ENABLED === true) {
    features.valence_model_version = VALENCE_MODEL_VERSION;
    try {
      const v = scoreValence(typeof args.content === "string" ? args.content : "");
      // Persist the structured object verbatim. scoreValence already returns
      // {sign, magnitude, source, model_version}; we keep it as-is so the
      // episodicity scorer's object-shape read (valence.magnitude,
      // valence.source !== 'absent') and a future v1 'model'-source swap both
      // work without a reshape.
      features.valence = v;
    } catch (err) {
      // Degrade to explicit null (NOT a half-built object). The episodicity
      // scorer's null-guard collapses to a 0 valence-magnitude input; the
      // index projection (factValenceScalar) reads null as "no signal".
      features.valence = null;
      console.error(
        `appendFactRow: valence scoring failed (degrading to features.valence=null): ${err && err.message ? err.message : String(err)}`,
      );
      synthDegradedReasons.push("valence_scorer_threw");
    }
  }

  // F-SYN-INTEGRATION-CASCADE-STAMPS-EPISODICITY — episodicity stamp.
  //
  // Runs AFTER the entity stamping so the scorer's `entity_generality` input
  // (computed inside computeFromFeatures via meanEntityGenerality over
  // features.entities[]) has the canonical entity list populated by the W3
  // step above. Stamps two row-level slots:
  //   - features.episodicity:         scalar ∈ [0,1] (the sigmoid output)
  //   - features.episodicity_version: pinned scorer version for drift
  //
  // Defensive degradation (mirrors the W3 entity-extractor pattern): any
  // throw from the scorer (future signature drift, math edge case, etc.)
  // MUST NOT break the ledger append. On throw we land features.episodicity
  // = null and features.episodicity_version = null; the recall-side
  // multiplicative gate (episodicityMatch) treats null-fact as the neutral
  // 0.5 contribution per spec invariant I-EPI-8. The fact row remains
  // durable and a future re-stamp pass (F-SYN-OPERATIONAL-drift-detection)
  // can backfill the field on scorer recovery.
  // WORKUNIT A-promote-projection (sentinel discipline, MAP finding N2.2):
  // features.episodicity_version is now ALWAYS stamped to the module constant —
  // even when the scorer throws. The constant is safe to read regardless of
  // scorer state, and a null version on a degraded row would silently exempt it
  // from drift-detection re-stamp passes. Only the SCALAR collapses to null on
  // throw; the version tag persists.
  features.episodicity_version = EPISODICITY_VERSION;
  try {
    features.episodicity = computeFromFeatures(features);
  } catch (err) {
    features.episodicity = null;
    // stderr breadcrumb mirrors the entity-extractor degrade branch so the
    // operator can detect a regression in field. No logger module is in
    // scope here; the rest of this file uses console.error for the same
    // class of soft-fail breadcrumb.
    console.error(
      `appendFactRow: episodicity scoring failed (degrading to features.episodicity=null): ${err && err.message ? err.message : String(err)}`,
    );
    synthDegradedReasons.push("episodicity_scorer_threw");
  }

  // WORKUNIT A-promote-projection — identity-key forwarding (thread_keys).
  //
  // Forward the source event's identity keys onto the fact so the thread /
  // project aggregators can bucket NEW facts WITHOUT a join back to the source
  // ledger (the read-side existing-row backlog is N7b's concern; this stamps
  // the forward-side). The keys are read from args.thread_keys, which the MCP
  // handler + watermark promoteSourceRow populate from the in-scope source row
  // (firstSourceRow.raw_content / event.raw_content) + event-level fields.
  //
  // Closed key set (the aggregator-relevant identity fields): chat_guid,
  // chat_identifier, repo_path, author_email, actor_login, repo,
  // conversation_id. We copy ONLY string-valued keys from this set — never an
  // arbitrary pass-through of raw_content (which can carry large message bodies
  // and PII the fact row must not duplicate). Empty → field omitted entirely.
  //
  // Default-ON, CAPS-gated (CASCADE_THREAD_KEYS_ENABLED). Defensive try/catch.
  if (CAPS.CASCADE_THREAD_KEYS_ENABLED === true) {
    try {
      const src = args.thread_keys;
      if (src != null && typeof src === "object" && !Array.isArray(src)) {
        const ALLOWED_THREAD_KEYS = [
          "chat_guid",
          "chat_identifier",
          "repo_path",
          "author_email",
          "actor_login",
          "repo",
          "conversation_id",
        ];
        const tk = {};
        for (const k of ALLOWED_THREAD_KEYS) {
          const val = src[k];
          if (typeof val === "string" && val.length > 0) tk[k] = val;
        }
        if (Object.keys(tk).length > 0) features.thread_keys = tk;
      }
    } catch (err) {
      console.error(
        `appendFactRow: thread_keys forwarding failed (degrading; row still promotes): ${err && err.message ? err.message : String(err)}`,
      );
      synthDegradedReasons.push("thread_keys_threw");
    }
  }

  // A1 — Carry attribution through promotion. Stamp a bounded, closed-key
  // features.attribution subset {sender_id, sender_name, peer_id, peer_name,
  // peer_type, is_outgoing, is_self, reply_to, fwd_from} forwarded from the
  // source row's connector-authored identity envelope (args.attribution, built
  // by extractAttributionFromSourceRow). The closed allowlist is RE-VALIDATED
  // here (defense-in-depth) so no key outside the set — and never the full
  // raw_content / message body — can reach the fact row. Empty → field omitted
  // (clean/non-messaging promotes stay byte-compatible; NO synth_degraded on
  // the empty path — only on a real throw). Default-ON, CAPS-gated
  // (CASCADE_ATTRIBUTION_ENABLED), defensive: a throw still promotes the row.
  if (CAPS.CASCADE_ATTRIBUTION_ENABLED === true) {
    try {
      const src = args.attribution;
      if (src != null && typeof src === "object" && !Array.isArray(src)) {
        const attr = {};
        for (const k of ALLOWED_ATTRIBUTION_KEYS) {
          const val = src[k];
          if (typeof val === "string" && val.length > 0) attr[k] = val;
          else if (typeof val === "number" && Number.isFinite(val)) attr[k] = val;
          else if (typeof val === "boolean") attr[k] = val;
        }
        if (Object.keys(attr).length > 0) features.attribution = attr;
      }
    } catch (err) {
      console.error(
        `appendFactRow: attribution forwarding failed (degrading; row still promotes): ${err && err.message ? err.message : String(err)}`,
      );
      synthDegradedReasons.push("attribution_threw");
    }
  }

  // WORKUNIT A-promote-projection — degraded-extraction sentinel block. Only
  // stamped when at least one synthesis stamp above degraded (recorded a
  // reason). A clean promote carries NO synth_degraded field, so the on-disk
  // shape for the common path is byte-compatible with pre-WU rows.
  if (synthDegradedReasons.length > 0) {
    features.synth_degraded = { reasons: synthDegradedReasons };
  }

  // R29.2 fix: top-level `source` field is now populated on new rows from
  // args.source_refs[0].source. Pre-R29.2 rows have source:null at top level;
  // features.source (mirror in salience block when present) is still
  // authoritative for legacy rows. Backfill of pre-R29.2 rows is optional in
  // R30+. Mirrors the pattern where `eventForSalience` reads
  // firstRef.source. args.source_refs is non-empty here (validated upstream
  // in the handler), so source_refs[0] is always defined.
  const rowWithoutChecksum = {
    id: memoryEventId,
    kind: "fact",
    content: args.content,
    source: args.source_refs[0] && args.source_refs[0].source,
    source_refs: args.source_refs.map((r) => ({
      source: r.source,
      source_msg_id: r.source_msg_id,
      via: "original",
      corroboration_event_id: null,
      consent_basis: consentBasisBySourceMsgId.get(r.source_msg_id) || null,
    })),
    derived_from: Array.isArray(args.derived_from) ? args.derived_from : [],
    provenance: {
      agent_id: args.provenance.agent_id,
      conversation_id: args.provenance.conversation_id,
      confidence: args.provenance.confidence,
    },
    features,
    created_at: promotedAt,
  };
  // WORKUNIT A-promote-projection — top-level `ts` mirror of created_at on NEW
  // rows. The thread / project aggregators guard on a top-level `ts` field
  // (the source-ledger rows they were written against carry `ts`, but a
  // promoted fact carries `created_at`); without this mirror a NEW fact is
  // silently skipped by their ts-presence guard. created_at remains the
  // authoritative promote-time field; ts is a pure mirror of the same ISO
  // string (confirmed no consumer mutates one independently of the other —
  // recall reads row.created_at, the checksum covers both identically).
  // Default-ON, CAPS-gated (CASCADE_TS_MIRROR_ENABLED). The mirror is part of
  // rowWithoutChecksum so the per-row checksum covers it (no torn-line risk).
  if (
    CAPS.CASCADE_TS_MIRROR_ENABLED === true &&
    typeof promotedAt === "string" &&
    promotedAt.length > 0
  ) {
    rowWithoutChecksum.ts = promotedAt;
  }
  // A1 — Carry attribution through promotion. Stamp a top-level `parties[]`
  // (the connector-authored audience array forwarded verbatim, filtered to
  // non-empty strings) as a sibling of content / source / source_refs /
  // created_at. Stamped only when non-empty (omitted when empty — additive,
  // byte-compatible with non-messaging facts; A2 read-side treats absent as
  // []). Part of rowWithoutChecksum so the per-row checksum covers it (no
  // torn-line risk). Additive metadata ONLY — does NOT feed content_hash,
  // source_refs_hash, the content-dedup gate, or the mem_... id (S5 identity
  // unchanged). Default-ON, CAPS-gated (CASCADE_ATTRIBUTION_ENABLED).
  if (CAPS.CASCADE_ATTRIBUTION_ENABLED === true) {
    const p = Array.isArray(args.parties)
      ? args.parties.filter((x) => typeof x === "string" && x.length > 0)
      : [];
    if (p.length > 0) rowWithoutChecksum.parties = p;
  }
  const checksum = rowChecksumHex(rowWithoutChecksum);
  const row = { ...rowWithoutChecksum, checksum };
  const bytes = Buffer.from(JSON.stringify(row) + "\n", "utf8");
  const fd = openSync(LEDGER_PATH, LEDGER_O_FLAGS, LEDGER_FILE_MODE);
  try {
    let written = 0;
    while (written < bytes.length) {
      written += writeSync(fd, bytes, written, bytes.length - written);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // Dir-fsync AFTER file-fsync + close, so the file's metadata link/length
  // is durable. Failures here propagate — better to surface a durability
  // hole loudly than silently accept a soft commit.
  fsyncDir(dirname(LEDGER_PATH));

  // WU2-inline-embed-and-remove-gemini-quota-machinery removed the async
  // embed-queue enqueue that used to fire here on the null-embed path. The
  // cascade now embeds inline via the local server; on a local-server outage
  // the watermark daemon records the fact id to the simple re-embed sweep
  // file AFTER this returns (it owns the source/cursor context). appendFactRow
  // stays a pure ledger-append + index-update chokepoint with no queue side
  // effects.
  //
  // WORKUNIT A-promote-projection — return the built `features` alongside the
  // id so the caller can hand the SAME features to updateIndicesForFact. This
  // lets the incremental BM25-add project valence + entities from the exact
  // on-row features (single source of truth) instead of re-deriving them. The
  // function is module-internal (not exported), so this return-shape change is
  // contained to the two in-file call sites.
  return { memoryEventId, features };
}

// updateIndicesForFact — sidecar invocation after the fact row is durably on
// disk. Phase 3 v0 wire-up: load BM25 + HNSW for the current embedding model
// version, add the new entry, save. Failures here do NOT roll back the fact
// row (it is already fsync'd); we leave a loud stderr breadcrumb and continue.
// Do NOT read that as "a rebuild will pick it up": with
// MEMORY_LEDGER_ROW_EMBEDDING_4096 off (the default — the flag is env-gated,
// see ledgerRowEmbedding4096FlagOn) the vector is not on the row and never
// reached the WAL, so a from-scratch rebuild has nothing to rebuild FROM. The
// index-failure catch blocks below each name the derived recovery predicate,
// and the residual note at the end of this file names the script that would
// apply it. (R29.3 retired the features.embedding_pending=true scan.)
function updateIndicesForFact({
  memoryEventId,
  content,
  promotedAt,
  vector_mrl_768,
  vector_4096,
  consentBasis,
  features,
}) {
  // WU2: the active local backend produces FULL 4096-dim vectors stored under
  // ACTIVE_EMBED_MODEL_VERSION; the legacy Gemini path stores 768-dim
  // MRL-sliced vectors under GEMINI_EMBEDDING_MODEL_DEFAULT. Index into the
  // HNSW whose model version matches the vector that was actually produced so
  // a 4096 add never lands in a 768 index (or vice versa).
  const usingLocal = Array.isArray(vector_4096) && vector_4096.length > 0;
  const usingLegacy = Array.isArray(vector_mrl_768) && vector_mrl_768.length > 0;
  const hasVector = usingLocal || usingLegacy;
  const modelVersion = usingLocal
    ? CAPS.ACTIVE_EMBED_MODEL_VERSION
    : usingLegacy
      ? CAPS.GEMINI_EMBEDDING_MODEL_DEFAULT
      : CAPS.ACTIVE_EMBED_MODEL_VERSION;
  const vector = usingLocal ? vector_4096 : usingLegacy ? vector_mrl_768 : null;
  const dimLabel = usingLocal ? "4096" : "768";
  const { bm25, hnsw } = loadIndices(modelVersion);
  // BM25 entry shape per IndexEntry contract (kb/phase3-v0-contracts.md § 1):
  //   memory_id, kind, content, ts, entities, valence, consent_basis...
  //
  // WORKUNIT A-promote-projection (MAP finding N2.4): the incremental-add path
  // here previously HARDCODED valence:null and entities:[], diverging from the
  // index-cache.js rebuild path (toIndexEntry) which projects from the row's
  // features. The two paths now agree: we project valence with the SAME
  // factValenceScalar helper index-cache.js uses, and lowercase the row's
  // canonical entity ids the SAME way. A row added incrementally is therefore
  // byte-identical to one materialized by a from-scratch rebuild.
  const f = features && typeof features === "object" ? features : {};
  const bm25Valence = factValenceScalar(f.valence);
  const bm25Entities = Array.isArray(f.entities)
    ? f.entities
        .filter((e) => e && typeof e.canonical_id === "string")
        .map((e) => e.canonical_id.toLowerCase())
        .filter((e) => e !== "")
    : [];
  const bm25Entry = {
    memory_id: memoryEventId,
    kind: "fact",
    content,
    ts: promotedAt,
    entities: bm25Entities,
    valence: bm25Valence,
    consent_basis: consentBasis || "first_party",
  };
  bm25.add(bm25Entry);
  // HNSW entry: L2-renormalized unit vector. l2NormAssert happens inside
  // HnswIndex.add via vector-math.l2NormAssert; we re-assert here
  // defensively at the index boundary.
  if (hasVector) {
    l2NormAssert(vector, "distill-promote-fact.updateIndicesForFact." + dimLabel);
    hnsw.add(memoryEventId, vector);
  }
  // W2-debounced-index-persistence — this used to be saveIndices(...), which
  // rewrote the FULL multi-GB hnsw.bin + bm25.json once per promoted fact
  // (~TB/day of SSD writes). The in-memory adds above are already visible to
  // recall via the loadIndices cache; scheduleSaveIndices appends a tiny
  // crc-framed fsync'd WAL record (S2; self-contained: the exact bm25Entry +
  // vector) and batches the full persist behind the W3 replay-cost budgets
  // (INDEX_SAVE_WAL_RECORDS/_BYTES/_MAX_STALENESS_MS; INDEX_SAVE_BATCH and
  // INDEX_SAVE_MAX_AGE_S remain honored as explicit legacy/test overrides).
  // Ordering invariant: this runs strictly AFTER appendFactRow fsync'd the
  // fact row, so index failure never rolls the row back.
  //
  // v3-ledger-embedding-reroute UPDATED THE SECOND HALF OF THAT INVARIANT. It
  // used to read "the ledger row (with the embedding inline) remains the
  // durable record". With MEMORY_LEDGER_ROW_EMBEDDING_4096 unset (the default)
  // the row is NO LONGER the durable record FOR THE VECTOR — the fsync'd WAL
  // record appended just below is. The row remains the durable record for
  // everything else (content, provenance, source_refs, all other features), and
  // fact identity/integrity are untouched (content_hash / source_refs_hash /
  // the mem_ id never read features; rowChecksumHex covers whatever features
  // were actually written, so old rows keep verifying against the old shape and
  // new rows against their own smaller one).
  //
  // RESIDUAL Fv3-2 — WAL quarantine. index-wal.js quarantines a corrupt WAL to
  // index-wal.jsonl.corrupt-<epoch-ms> (bytes retained, never unlinked) and
  // continues on a fresh WAL. Any record lost that way leaves its fact with NO
  // recoverable vector and NO marker: this path wrote embed_state=false, and
  // no sweep entry is appended for it. (Nothing enumerates rows by
  // embed_state at all — the sweep file is an append-driven work list, not a
  // scan. See the residual note at the end of this file.) Recovery requires
  // the derived predicate below.
  //
  // RESIDUAL Fv3-2 (sidecar) — cascade promotes never mirror into vectors.jsonl
  // (only scripts/reembed-local-4096.mjs writes that sidecar). So a new fact's
  // 4096 vector now exists in exactly TWO places: the WAL (until compaction
  // empties it) and hnsw.bin (after publish). Since --build-hnsw sources from
  // the sidecar, a from-scratch --build-hnsw would now DROP these facts;
  // vector-corpus reconciliation is a prerequisite for ever running it again.
  //
  // RESIDUAL Fv3-4 — every call site of this function is best-effort
  // (try/catch + a stderr breadcrumb). See those three breadcrumbs.
  //
  // RECOVERY PREDICATE for all of the above: a fact whose vector should be in
  // the 4096 index but is not on its row is enumerable ONLY as
  //   features.embed_state === false
  //   && features.embedding_model_version === CAPS.ACTIVE_EMBED_MODEL_VERSION
  //   && !("embedding_4096" in features)
  // Do not drop embedding_model_version from the stamp above as "redundant".
  scheduleSaveIndices(
    modelVersion,
    { bm25, hnsw },
    { factId: memoryEventId, bm25Entry, vector: hasVector ? vector : null },
  );
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handler(args) {
  // Step 2: payload validation. Throws ToolError(INVALID_ARGUMENTS) which
  // dispatch will marshal into the envelope. Unknown keys are rejected by
  // assertObjectShape; missing confirmation_token surfaces here.
  validatePayload(args);

  // Step 3a: compute binding_object. content_hash is sha256 over the RAW
  // utf-8 bytes of args.content — spec § Handler steps line: "content_hash
  // = sha256(content) — raw UTF-8 bytes of the content field, NOT
  // canonicalized". NFC normalization MUST NOT be applied. source_refs_hash
  // is sha256(canonical_json(args.source_refs)); JCS preserves array order
  // so the supervisor must hash in the same order it submits.
  const contentHash = createHash("sha256")
    .update(Buffer.from(args.content, "utf8"))
    .digest("hex");
  const sourceRefsHash = canonicalJsonSha256Hex(args.source_refs);
  const bindingObject = {
    content_hash: contentHash,
    source_refs_hash: sourceRefsHash,
  };

  // Step 3b: token verification — type+freshness + signature.
  // loadSigningKey enforces the 0600 / O_NOFOLLOW / nlink == 1 discipline;
  // failure here is INTERNAL_ERROR (the daemon's signing key is corrupt or
  // missing — operator intervention required).
  let signingKey;
  try {
    signingKey = loadSigningKey().key;
  } catch (e) {
    return errEnv(
      NAME,
      ERROR_CODES.INTERNAL_ERROR,
      `signing key unavailable: ${e.message}`,
    );
  }

  const verified = verifyToken(args.confirmation_token, signingKey);
  if (verified.ok !== true) {
    // The raw token NEVER reaches policy-events.jsonl; nonce_hash is only
    // available when the payload parsed (steps after "malformed"). The
    // verifyToken helper returns nonce_hash on success and omits it
    // otherwise; here we default to null per spec § Logging:
    // "nonce_hash_or_null is null when rejection fires before payload parse".
    appendPolicyEvent({
      kind: "policy.token.rejected",
      nonce_hash_or_null: verified.nonce_hash || null,
      reason: verified.reason,
      attempted_at: serverTs(),
    });
    return errEnv(
      NAME,
      ERROR_CODES.PRIVILEGE_REQUIRED,
      "daemon-signed token rejected",
      { reason: verified.reason },
    );
  }

  // Step 3c: binding. Nonce is NOT consumed on binding mismatch — preserves
  // the slot for the legitimate caller. verifyBinding returns boolean.
  if (!verifyBinding(verified.payload, bindingObject)) {
    appendPolicyEvent({
      kind: "policy.token.rejected",
      nonce_hash_or_null: verified.nonce_hash,
      reason: "binding_mismatch",
      attempted_at: serverTs(),
    });
    return errEnv(
      NAME,
      ERROR_CODES.PRIVILEGE_REQUIRED,
      "daemon-signed token rejected",
      { reason: "binding_mismatch" },
    );
  }

  // Step 3d: nonce single-use. The verifier resolves `tool` to the actual
  // MCP tool name — never trust the caller's claim (NAME is the constant).
  // checkAndConsume runs under the consumed-nonces.lock critical section;
  // on replay it returns { ok: false, reason: "nonce_replayed" }.
  let consumed;
  try {
    consumed = checkAndConsume(verified.nonce_hash, NAME);
  } catch (e) {
    return errEnv(
      NAME,
      ERROR_CODES.INTERNAL_ERROR,
      `nonce-store unavailable: ${e.message}`,
    );
  }
  if (consumed.ok !== true) {
    appendPolicyEvent({
      kind: "policy.token.rejected",
      nonce_hash_or_null: verified.nonce_hash,
      reason: consumed.reason,
      attempted_at: serverTs(),
    });
    return errEnv(
      NAME,
      ERROR_CODES.PRIVILEGE_REQUIRED,
      "daemon-signed token rejected",
      { reason: consumed.reason },
    );
  }

  // Step 3e: tool-specific consent. Per spec § Privilege levels step 5:
  // "the nonce is durably appended" first, then this check runs. A
  // CONSENT_BLOCKED failure here leaves the nonce consumed — the supervisor
  // must mint a fresh token for the retry; consent state may have changed
  // between calls and re-binding forces fresh review. NOT_FOUND on a missing
  // source row likewise consumes the nonce: the supervisor's mint was for
  // arguments that did not actually point at promotable data.
  //
  // Side-effect: collect the per-source consent_basis to forward into the
  // fact-row source_refs[].consent_basis field (H7 fix; see appendFactRow
  // comment and kb/architecture.md § Memory ledger).
  const consentBasisBySourceMsgId = new Map();
  // R25: capture the first source row so the salience cascade (Layer 1
  // Stage-0 modules + Layer 2 recency / authorship) can read the raw
  // source-ledger fields (associated_message_type for tapback, urn:biz:
  // handle for business-handle, ZSTREAMNAME for ScreenTime, the commit
  // subject for git, the event_type for github-events) without re-reading
  // the source ledger from disk. The first source_ref is the salience
  // anchor; secondary source_refs are corroborating refs that don't
  // contribute to the cascade decision (they share the same content_hash
  // by binding-object construction).
  let firstSourceRow = null;
  try {
    for (let i = 0; i < args.source_refs.length; i++) {
      const ref = args.source_refs[i];
      const row = loadSourceRow(ref.source, ref.source_msg_id);
      assertSourceRowAllowsPromotion(row, ref.source, ref.source_msg_id);
      // Safe to read after assertSourceRowAllowsPromotion (it validates the
      // shape and the basis enum). Forward verbatim.
      consentBasisBySourceMsgId.set(
        ref.source_msg_id,
        row.source_policy.consent_basis,
      );
      if (i === 0) firstSourceRow = row;
    }
  } catch (e) {
    if (e instanceof ToolError) {
      // No policy event for NOT_FOUND or CONSENT_BLOCKED — those are not
      // token-verification reasons. The token was VERIFIED (steps 1-4 passed
      // and the consumed event will NOT fire because we did not commit work).
      // Spec § Logging enumerates only mint/consume/reject as token events;
      // tool-level NOT_FOUND/CONSENT_BLOCKED do not get their own audit row.
      throw e;
    }
    return errEnv(
      NAME,
      ERROR_CODES.INTERNAL_ERROR,
      `source-policy check failed: ${e.message}`,
    );
  }

  // Step 4: dedupe + ledger append. Phase 1 STUB per task: dedupe always
  // returns "promoted"; the cross-source dedupe path (corroborated_existing,
  // linked_via_derivation) lands when the salience index ships.
  //
  // Phase 3 v0 wire-up: embed at promote-time. l14-embed-callers-migrate
  // repointed this from gemini-client.embedSingle(RETRIEVAL_DOCUMENT) to
  // local-embedder-client.embedSingle({isQuery:false}) — same document-side
  // polarity, full 4096 dims instead of a 3072->768 MRL slice. On success the
  // row carries features.embedding_model_version = ACTIVE_EMBED_MODEL_VERSION +
  // embed_state=false and NO inline vector (appendFactRow's
  // `ok === true && Array.isArray(vector_4096)` arm; the vector travels
  // out-of-band through the index WAL unless
  // MEMORY_LEDGER_ROW_EMBEDDING_4096=1). On embed-server outage the row still
  // lands (data capture has priority) with every embedding field an EXPLICIT
  // null and features.embed_state=true — appendFactRow's third (`else`) branch
  // — which is byte-identical to the degrade this handler produced on a Gemini
  // outage before the migration. R29.3 retired the features.embedding_pending
  // marker; embed_state is the discriminator now. NOTE (carried, not
  // introduced here): unlike the watermark path, this handler does NOT append
  // the fact id to the re-embed sweep file, AND no other mechanism enumerates
  // such rows — no code anywhere scans for embed_state === true. A row that
  // lands here is not automatically revisited by anything. See the residual
  // note at the end of this file for the reconciliation script that would
  // close this, which does not exist yet.
  // See kb/phase3-v0-contracts.md § 9 "Graceful degrade discipline".
  //
  // ATOMICITY: the embed happens BEFORE ledger append so the embedding (or
  // its absence) is part of the durably-fsync'd row. Index update happens
  // AFTER ledger fsync; if the index write fails the fact is still promoted
  // (priority is data capture) and a stderr breadcrumb is emitted.
  let embedOutput;
  try {
    // isQuery:false — this text is a DOCUMENT (a fact being written to the
    // ledger), not a recall query. Mapping evidence at the import above.
    // The result shape is repointed in the SAME edit as the import: local's
    // embedSingle returns { vector_4096, embedding_model_version } and NOTHING
    // else, so reading embedRes.vector_3072 / .vector_mrl_renormalized here
    // would silently yield undefined and drive appendFactRow into its
    // `else if (embedOutput.ok === true)` legacy-Gemini branch. Byte-matches
    // the already-migrated promoteSourceRow embedOutput shape (its
    // `if (embedding4096)` arm).
    const embedRes = await trackedEmbedSingle({
      text: args.content,
      isQuery: false,
    });
    embedOutput = {
      ok: true,
      vector_4096: embedRes.vector_4096,
    };
  } catch (e) {
    console.error(
      `memory_distill_promote_fact: local embed failed (row appended with explicit-null embedding fields + embed_state=true; NO re-embed sweep entry was written and no automated path will revisit this row — re-embed it manually): ${e && e.message ? e.message : String(e)}`,
    );
    embedOutput = { ok: false };
  }

  // MEMORY_SALIENCE_BYPASS — escape hatch for legacy hermetic integration
  // tests that pre-date the R25 cascade and assume every promote attempt
  // produces a new fact row. Production code never sets this; tests that
  // need to assert pre-cascade plumbing (Phase 3 v0 integration scaffolds,
  // promote-time embedding fixtures, durability harness) opt out via
  // process.env. The supervisor process intentionally does NOT set this
  // env var, so the cascade is always active in real runs.
  const SALIENCE_BYPASS =
    process.env.MEMORY_SALIENCE_BYPASS === "1" ||
    process.env.MEMORY_SALIENCE_BYPASS === "true";

  // R25 salience cascade — Layer 1 Stage-0 + Layer 2 components + Layer 3
  // novelty / corroboration. Lives BETWEEN embed and ledger append so the
  // 768d MRL vector is available for the kNN call AND the cascade decision
  // is reflected on the appended fact row's features.salience block.
  //
  // Cascade decisions:
  //   DROP / REDACT_DROP -> no fact row appended; policy.salience.dropped
  //     or policy.salience.redacted has already been emitted inside
  //     scoreCandidate. policy.token.consumed IS emitted (the supervisor's
  //     token did its job — the decision to not promote is the work).
  //     Returns dedupe_action="salience_dropped" so the supervisor can
  //     surface the drop in batch logs.
  //   CORROBORATE -> no fact row appended; policy.corroboration emitted
  //     pointing at the corroboration target. policy.token.consumed IS
  //     emitted. Returns dedupe_action="corroborated_existing" matching
  //     the spec's cross-source dedupe vocabulary.
  //   PROMOTE -> features.salience block built and threaded into the fact
  //     row via appendFactRow(...salienceFeatures); existing promote path
  //     continues unchanged.
  //
  // Failure mode: if scoreCandidate throws (Stage-0 module bug, kNN crash,
  // policy-events lock contention), we fall through to a PROMOTE with no
  // salience block — the row appends without features.salience and a
  // backfill sweep can re-score it later. Better to capture the data
  // than to refuse it on a salience-layer bug.
  const firstRef = args.source_refs[0];
  const eventForSalience = SALIENCE_BYPASS
    ? null
    : {
    source: firstRef.source,
    source_msg_id: firstRef.source_msg_id,
    content: args.content,
    consent_basis: consentBasisBySourceMsgId.get(firstRef.source_msg_id) || null,
    ts:
      firstSourceRow && typeof firstSourceRow.ts === "string"
        ? firstSourceRow.ts
        : serverTs(),
    raw: firstSourceRow,
  };
  const salienceCtx = SALIENCE_BYPASS ? null : {
    // l14-embed-callers-migrate — the vector is now 4096-dim, so it must ride
    // the 4096 key. salience.js's emb-selection block (the `let emb = null`
    // ladder in scoreCandidate) tests `Array.isArray(ctx.embedding_4096)`
    // FIRST and only falls back to ctx.embedding_mrl_768, so this key selects
    // the branch that keeps the vector intact; the kNN below is
    // dimension-agnostic.
    embedding_4096:
      embedOutput && embedOutput.ok === true
        ? embedOutput.vector_4096
        : null,
    hnsw: (() => {
      // Reuse the recall-layer HNSW for the kNN. loadIndices is cached and
      // cheap; on first call after process start it warms from disk. If
      // loading fails we degrade to null and the scorer skips Layer 3.
      //
      // l14-embed-callers-migrate — LOAD-BEARING model-version swap. The
      // vector above is now the local 4096-dim embedding; loading
      // CAPS.GEMINI_EMBEDDING_MODEL_DEFAULT here would kNN a 4096 vector
      // against the 768-dim gemini index tree. The active tree is the only
      // one whose geometry matches, and it is the same tree the write side
      // targets: updateIndicesForFact's `usingLocal` model-version ternary
      // (`const modelVersion = usingLocal ? CAPS.ACTIVE_EMBED_MODEL_VERSION
      // : ...`) routes a vector_4096 to CAPS.ACTIVE_EMBED_MODEL_VERSION.
      try {
        const { hnsw } = loadIndices(CAPS.ACTIVE_EMBED_MODEL_VERSION);
        return hnsw;
      } catch {
        return null;
      }
    })(),
  };
  let salienceResult;
  if (SALIENCE_BYPASS) {
    salienceResult = { decision: "PROMOTE", score: null, components: null };
  } else {
    try {
      salienceResult = await scoreCandidate(eventForSalience, salienceCtx);
    } catch (e) {
      console.error(
        `memory_distill_promote_fact: salience cascade threw (treating as PROMOTE with no salience block): ${e && e.message ? e.message : String(e)}`,
      );
      salienceResult = { decision: "PROMOTE", score: null, components: null };
    }
  }

  if (
    salienceResult.decision === "DROP" ||
    salienceResult.decision === "REDACT_DROP"
  ) {
    // Stage-0 already emitted policy.salience.dropped/redacted. Emit
    // policy.token.consumed so the supervisor's mint/consume audit trail
    // closes cleanly, then return.
    //
    // F-NEW-W4-VERIFY-MEMORY-DISTILL-FALSE-OK: the envelope MUST surface the
    // drop EXPLICITLY so callers cannot conflate "promoted, here is your
    // memory_event_id" with "Stage-0 dropped the row, memory_event_id is null".
    // Pre-fix the envelope returned ok=true with memory_event_id=null and
    // dedupe_action="salience_dropped", which downstream callers (and the
    // memory-jsonl-durability test) treated as success-with-row-on-disk. We
    // now ADD two top-level data fields:
    //   - dropped: true            — boolean flag, easy to branch on
    //   - drop_reason: <string>    — the salience reason or decision verbatim
    // dedupe_action="salience_dropped" and salience_reason are preserved for
    // backward compatibility with callers that already key off them.
    appendPolicyEvent({
      kind: "policy.token.consumed",
      nonce_hash: verified.nonce_hash,
      tool: NAME,
      accepted_at: consumed.accepted_at,
    });
    return ok(NAME, {
      memory_event_id: null,
      promoted_at: null,
      dedupe_action: "salience_dropped",
      salience_reason: salienceResult.reason || salienceResult.decision,
      dropped: true,
      drop_reason: salienceResult.reason || salienceResult.decision,
    });
  }
  if (salienceResult.decision === "CORROBORATE") {
    appendPolicyEvent({
      kind: "policy.token.consumed",
      nonce_hash: verified.nonce_hash,
      tool: NAME,
      accepted_at: consumed.accepted_at,
    });
    return ok(NAME, {
      memory_event_id: null,
      promoted_at: null,
      dedupe_action: "corroborated_existing",
      corroboration_target: salienceResult.target_id,
    });
  }
  // PROMOTE — build the features.salience block. null components is the
  // exception path (Layer 3 threw); we still promote but without the block.
  let salienceFeatures = null;
  if (salienceResult.components != null) {
    try {
      salienceFeatures = buildSalienceFeaturesBlock(salienceResult);
    } catch {
      salienceFeatures = null;
    }
  }

  const promotedAt = serverTs();
  // W1-CCS — F-CCS-CASCADE-row-parties-as-entities. Thread the source-row's
  // parties[] into args so appendFactRow's parties-stamp branch can promote
  // them into features.entities. firstSourceRow is the source-ledger row
  // for source_refs[0] loaded during the consent walk above; its parties[]
  // is the connector-authored audience for the underlying source event.
  // When the source row lacks parties (e.g. a hand-mocked source ledger in
  // a hermetic test, or a future connector that doesn't populate the
  // field), args.parties stays an empty array and the stamp branch
  // gracefully no-ops.
  // WU-forward-conversation-stamp (MCP path). The supervisor-supplied
  // args.provenance.conversation_id is null; firstSourceRow is the source-
  // ledger row for source_refs[0] (loaded during the consent walk above) and
  // carries the raw_content thread key. Derive "daemon:thread:<bucket_key>"
  // and inject it into provenance so appendFactRow stamps it on the new row.
  // Defensive: deriveConversationId returns null for a non-thread-bearing
  // source or a malformed row; we only override when a real descriptor
  // resolves, leaving provenance.conversation_id null otherwise (the prior
  // behavior). args.provenance is always an object here (validated upstream).
  const derivedConversationId = deriveConversationId(firstSourceRow);
  const argsWithParties = {
    ...args,
    parties:
      firstSourceRow && Array.isArray(firstSourceRow.parties)
        ? firstSourceRow.parties
        : [],
    // WORKUNIT A-promote-projection — forward the source row's identity keys so
    // appendFactRow stamps features.thread_keys. firstSourceRow is the
    // source-ledger row for source_refs[0] loaded during the consent walk; its
    // raw_content carries chat_guid / repo_path / etc. Empty when the row lacks
    // identity fields (e.g. a hand-mocked hermetic ledger) — stamp no-ops.
    thread_keys: extractThreadKeysFromSourceRow(firstSourceRow),
    // A1 — Carry attribution through promotion. firstSourceRow.raw_content
    // carries the connector-authored identity envelope (telegram sender/peer,
    // imessage handle_id + is_from_me, whatsapp jid + is_from_me, mail From
    // header). extractAttributionFromSourceRow returns the bounded closed-key
    // subset; appendFactRow stamps it onto features.attribution (never the full
    // raw_content). {} for non-messaging sources → stamp no-ops (back-compat).
    attribution: extractAttributionFromSourceRow(firstSourceRow),
    provenance: {
      ...args.provenance,
      conversation_id:
        derivedConversationId != null
          ? derivedConversationId
          : args.provenance && args.provenance.conversation_id != null
            ? args.provenance.conversation_id
            : null,
    },
  };
  let memoryEventId;
  let appendedFeatures;
  try {
    ({ memoryEventId, features: appendedFeatures } = appendFactRow(
      argsWithParties,
      promotedAt,
      consentBasisBySourceMsgId,
      embedOutput,
      salienceFeatures,
    ));
  } catch (e) {
    // Ledger write failure on the success path is INTERNAL_ERROR. The nonce
    // is consumed and the policy.token.consumed event has NOT yet fired, so
    // the audit log will show a verified-but-uncommitted call — a known
    // shape on disk-full / permission-denied paths. Surface clearly rather
    // than retry behind the caller's back.
    return errEnv(
      NAME,
      ERROR_CODES.INTERNAL_ERROR,
      `ledger append failed: ${e.message}`,
    );
  }

  // Phase 3 v0 wire-up: update BM25 + HNSW indices for the new fact. By
  // default this remains embed-success-only; the rollout flag also keeps
  // BM25 warm on the pending path while leaving HNSW untouched. Index update
  // failure is logged but does NOT roll back the fact row.
  if (embedOutput.ok === true || bm25DecoupleEmbedFlagOn()) {
    try {
      const firstSrcMsgId = args.source_refs[0] && args.source_refs[0].source_msg_id;
      const consentBasis =
        (firstSrcMsgId && consentBasisBySourceMsgId.get(firstSrcMsgId)) || "first_party";
      updateIndicesForFact({
        memoryEventId,
        content: args.content,
        promotedAt,
        // l14-embed-callers-migrate — vector_mrl_768 stays wired (it is
        // undefined on this path now) and vector_4096 carries the local
        // vector; updateIndicesForFact's `usingLocal` model-version ternary
        // (`const modelVersion = usingLocal ? CAPS.ACTIVE_EMBED_MODEL_VERSION
        // : ...`) already prefers vector_4096 and routes it to
        // CAPS.ACTIVE_EMBED_MODEL_VERSION with no edit there.
        vector_mrl_768: embedOutput.vector_mrl_renormalized,
        vector_4096: embedOutput.vector_4096,
        consentBasis,
        // WORKUNIT A-promote-projection — pass the SAME features the row was
        // written with so the BM25-add projects valence + entities identically
        // to the rebuild path.
        features: appendedFeatures,
      });
    } catch (e) {
      // Fv3-4 (v3-ledger-embedding-reroute): this used to be harmless — the
      // ledger row still held the vector, so a rebuild recovered it. With
      // MEMORY_LEDGER_ROW_EMBEDDING_4096 off, an index-write failure here is
      // OUTRIGHT VECTOR LOSS with no marker: the row has no vector and the WAL
      // never got one. Nothing revisits this fact — the re-embed sweep file is
      // an append-driven work list written only when embed itself FAILED, and
      // this is the embed-SUCCESS path, so no entry was ever appended for it
      // (and no code anywhere enumerates rows by embed_state). Re-embed it via
      // the derived predicate: embed_state===false &&
      // embedding_model_version===<active> && no embedding_4096 on the row.
      console.error(
        `memory_distill_promote_fact: index update failed for ${memoryEventId}: ${e && e.message ? e.message : String(e)}; the 4096 vector is now UNRECOVERABLE from the ledger row (MEMORY_LEDGER_ROW_EMBEDDING_4096 off) and no re-embed marker was set`,
      );
    }
  }

  // Step 5: emit policy.token.consumed. Spec freeze
  // (kb/agent-integration.md § Token-event ownership table AUTHORITATIVE):
  // this handler is the SOLE producer of "policy.token.consumed".
  //
  // round-15 H3 ordering: the event is emitted AFTER appendFactRow has
  // file-fsync'd AND dir-fsync'd the new row. The previous lag (consumed
  // emitted only after ledger append) is preserved and tightened: ledger
  // durability now precedes the audit row. Rationale:
  //   - If appendFactRow throws, the consumed event is NOT emitted (control
  //     falls through to the INTERNAL_ERROR branch above this point) — leaves
  //     a minted-without-consumed gap, which is operator-detectable via the
  //     audit log join.
  //   - If appendFactRow succeeds and then appendPolicyEvent fails, the row
  //     IS durably on disk but the audit trail is incomplete. That is the
  //     direction this ordering biases — torn fact-row is silently bad data;
  //     missing audit row is loudly bad and operator-recoverable.
  // The alternative (consumed-iff-committed via nested locks across the MCP
  // handler + ledger file + policy-events file) is the pattern explicitly
  // rejected in kb/mcp-surface.md — the paragraph beginning "Rationale:
  // consumed-on-attempt-at-step-4 is the only viable order under a single
  // critical section" (l16: was cited as :227, which had drifted).
  //
  // Per the AUTHORITATIVE table: this handler is also the SOLE producer of
  // "policy.token.rejected" (above, on any verifyToken / verifyBinding /
  // checkAndConsume failure). The supervisor (distillation-supervisor.js)
  // is the SOLE producer of "policy.token.minted" — it emits that event
  // immediately after mintToken succeeds and before invoking this handler.
  appendPolicyEvent({
    kind: "policy.token.consumed",
    nonce_hash: verified.nonce_hash,
    tool: NAME,
    accepted_at: consumed.accepted_at,
  });

  return ok(NAME, {
    memory_event_id: memoryEventId,
    promoted_at: promotedAt,
    dedupe_action: "promoted",
  });
}

// ---------------------------------------------------------------------------
// appendOperatorFact — non-MCP entry point for an OPERATOR-AUTHORED direct
// memory write (WORKUNIT N8 / memory_put). The operator IS the trust root, so
// this path deliberately SKIPS the three machinery layers the MCP promote path
// owns:
//   - No daemon-token verification (no confirmation_token; the operator is not
//     a sandboxed distillation child — they are first-party).
//   - No source-ledger consent walk (there is no upstream connector row to walk;
//     the operator asserts their OWN basis directly, consent_basis="first_party").
//   - No salience cascade / scoreCandidate admission control (the operator's
//     deliberate act of recording the fact IS the admission decision).
//
// What it DOES reuse — the exact `appendFactRow` chokepoint. By
// routing through appendFactRow the operator fact inherits the FULL synthesis
// stamp cascade with zero re-implementation: features.entities (entity
// extractor over the "manual" source scope), features.entity_extractor_version,
// gazetteer adds, row-parties, features.time_anchors[0] = {kind:"absolute",
// instant_iso: promotedAt, structural:true, stamped_by:"cascade:row-ts"},
// features.valence, features.episodicity ∈ [0,1], features.thread_keys, and the
// synth_degraded sentinel on any extractor throw. It also inherits the ledger
// durability discipline (file-fsync + dir-fsync + per-row checksum + O_APPEND).
//
// Thesis #1: this only APPENDS one new fact row (via appendFactRow's append-only
// O_APPEND ledger write). It NEVER mutates an existing fact row.
//
// Embedding at v0: optional. The default is no inline embed — the row lands
// embeddingless (features.embedding_4096=null, embed_state=true) and NOTHING
// automatically revisits it: appendOperatorFact writes no re-embed sweep entry
// (only the watermark daemon does) and nothing enumerates rows by embed_state.
// That makes such a row one of the two STRANDED populations named in the
// residual note at the end of this file; re-embed it manually. (R29.3
// structural absence; NO embedding_pending marker.) The caller MAY pass a
// precomputed vector_4096 to embed inline.
//
// Lexical indexing of an embeddingless put (F1 first-run). On a standalone
// install with no vector index (standaloneLexicalFirstRun(): not a queryd
// client AND the on-disk tree for the active model holds no vector index —
// absent, or only the install's own empty-HNSW generation, intact and loading
// with zero vectors) the put IS added to the ACTIVE model's
// BM25 at write time, with a vector-less WAL record, so memory_recall serves it
// lexically (degraded_recall, reason dense_leg_unservable) in this process and
// after a restart. It still has no vector and is still stranded for the DENSE
// leg exactly as described above. On a configured install (queryd serving, or
// any vector in the active index, or an index that is refused, truncated or
// unreadable) nothing changes: an embeddingless put is lexically indexed only
// under MEMORY_BM25_DECOUPLE_EMBED.
//
// Args:
//   { content, provenance, source_refs?, derived_from?, vector_4096? }
//     content      — non-empty string (validated by the handler before this call)
//     provenance   — { agent_id?, conversation_id?, confidence } — operator stamp
//     source_refs  — optional; defaults to a single synthetic operator ref
//                    [{source:"manual", source_msg_id:<minted>}]. consent_basis
//                    is ALWAYS forced to "first_party" regardless of any ref.
//     derived_from — optional array of memory_event_ids this fact was derived from
//     vector_4096  — optional precomputed L2-unit 4096 vector for inline embed
//   { now } — optional Date / ms / ISO for test injection.
//
// Returns: { ok: true, memory_event_id, promoted_at }
// ---------------------------------------------------------------------------
export async function appendOperatorFact(
  { content, provenance, source_refs, derived_from, vector_4096 } = {},
  { now } = {},
) {
  if (typeof content !== "string" || content.trim() === "") {
    throw new TypeError("appendOperatorFact: content must be a non-empty string");
  }
  if (provenance == null || typeof provenance !== "object") {
    throw new TypeError("appendOperatorFact: provenance must be an object");
  }

  // Synthesize the operator source_refs. When the caller supplies source_refs
  // we keep their {source, source_msg_id} shape but DO NOT inherit any
  // consent_basis they may have attached — the operator asserts first_party
  // (consent honesty: a forged ref pointing at a real connector source_msg_id
  // must NOT pass off that connector's basis). When absent, mint a single
  // synthetic operator ref over the "manual" source scope so the entity
  // extractor (which gates on ENTITY_SOURCE_SCOPES) actually runs.
  const operatorSourceMsgId = "operator:" + randomBytes(8).toString("hex");
  const refs =
    Array.isArray(source_refs) && source_refs.length > 0
      ? source_refs.map((r) => ({
          source:
            r && typeof r.source === "string" && r.source.length > 0
              ? r.source
              : "manual",
          source_msg_id:
            r && typeof r.source_msg_id === "string" && r.source_msg_id.length > 0
              ? r.source_msg_id
              : operatorSourceMsgId,
        }))
      : [{ source: "manual", source_msg_id: operatorSourceMsgId }];

  // consent_basis is ALWAYS "first_party" for an operator put — every ref maps
  // to first_party in the consent map appendFactRow consults at row assembly.
  const consentMap = new Map();
  for (const r of refs) consentMap.set(r.source_msg_id, "first_party");

  const args = {
    content,
    source_refs: refs,
    derived_from: Array.isArray(derived_from) ? derived_from : [],
    provenance: {
      agent_id:
        provenance.agent_id != null ? provenance.agent_id : "operator",
      conversation_id:
        provenance.conversation_id != null ? provenance.conversation_id : null,
      confidence:
        typeof provenance.confidence === "string"
          ? provenance.confidence
          : "high",
    },
    // The operator put carries no connector audience metadata and no source-row
    // identity keys; the cascade treats empty arrays/objects as "nothing to
    // stamp" and the row-ts / entity / episodicity stamps still fire.
    parties: [],
    thread_keys: {},
    // A1 — operator puts carry no connector attribution metadata; empty →
    // features.attribution stamp no-ops (shape uniformity with the two cascade
    // paths above).
    attribution: {},
  };

  const nowMs =
    now instanceof Date
      ? now.getTime()
      : typeof now === "number"
        ? now
        : typeof now === "string" && now.length > 0
          ? Date.parse(now)
          : Date.now();
  const promotedAt =
    typeof now === "string" && now.length > 0 && Number.isFinite(Date.parse(now))
      ? now
      : new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();

  // v0 embed policy: inline-embed only when the caller handed us a precomputed
  // vector. Otherwise the row lands embeddingless and STRANDED — no sweep entry
  // is written on this path and nothing enumerates rows by embed_state, so it
  // needs a manual re-embed (see the doc block above and the residual note at
  // the end of this file). An embedder outage MUST NOT block an operator put.
  const embedOutput =
    Array.isArray(vector_4096) && vector_4096.length > 0
      ? { ok: true, vector_4096 }
      : { ok: false };

  let memoryEventId;
  let appendedFeatures;
  try {
    ({ memoryEventId, features: appendedFeatures } = appendFactRow(
      args,
      promotedAt,
      consentMap,
      embedOutput,
      null, // no salience block — operator puts are not cascade-scored
    ));
  } catch (err) {
    throw new Error(
      "appendOperatorFact: ledger append failed: " +
        (err && err.message ? err.message : String(err)),
    );
  }

  // Index update is best-effort. It runs with an inline vector; the rollout
  // flag additionally permits a BM25-only update; and so does a standalone
  // first run (no queryd, no vector index on disk — see standaloneLexicalFirstRun),
  // where the BM25-only add is what makes the put recallable at all. The
  // predicate is consulted last, so neither an inline vector nor the flag ever
  // reaches it. Failure here does NOT roll back the durably-fsync'd fact row.
  if (
    embedOutput.ok === true ||
    bm25DecoupleEmbedFlagOn() ||
    (await standaloneLexicalFirstRun())
  ) {
    try {
      updateIndicesForFact({
        memoryEventId,
        content,
        promotedAt,
        vector_4096,
        consentBasis: "first_party",
        features: appendedFeatures,
      });
    } catch (e) {
      // Fv3-4 — see the identical note on the handler's breadcrumb. With
      // MEMORY_LEDGER_ROW_EMBEDDING_4096 off this is silent vector loss, not a
      // recoverable index gap; the row survives, the vector does not, and no
      // sweep entry exists for it (the sweep records embed FAILURES, and this
      // is the embed-success path). Recover via the derived predicate.
      console.error(
        `appendOperatorFact: index update failed for ${memoryEventId}: ${e && e.message ? e.message : String(e)}; the 4096 vector is now UNRECOVERABLE from the ledger row (MEMORY_LEDGER_ROW_EMBEDDING_4096 off) and no re-embed marker was set`,
      );
    }
  }

  return {
    ok: true,
    memory_event_id: memoryEventId,
    promoted_at: promotedAt,
  };
}

// ---------------------------------------------------------------------------
// promoteSourceRow — non-MCP entry point used by daemons/watermark.js after
// the salience cascade returns PROMOTE on a row read out of
// storage/sources/*.jsonl.
//
// CRIT-1b (R25.5): this export was missing in R25; the watermark daemon's
// `typeof mods.promote.promoteSourceRow === "function"` guard silently
// evaluated to false, so 163,200 PROMOTE-decisioned rows never produced any
// fact-row writes. The fix is to add the export AND make it directly
// importable (no `typeof` shield needed by callers).
//
// Args:
//   { event, source, salience } — event is the source-ledger raw row OR the
//   normalized event that scoreCandidate just consumed; source is the
//   source-ledger name; salience is the {decision:"PROMOTE",score,
//   components,weights_hash,version} returned by scoreCandidate.
//   { now } — optional Date / ms for test injection.
//
// Returns: { ok: true, memory_event_id, promoted_at }
//
// Differences vs the MCP handler path:
//   - No daemon-token verification (the watermark daemon is in-process and
//     trusted; the cascade itself acted as the admission control).
//   - No source-ledger consent walk (the watermark only ingests rows that
//     were already written by a connector, which set consent_basis at the
//     source-row level; we forward verbatim).
//   - No embedding minted at this layer — the cascade (scoreCandidate) has
//     already produced an MRL-768d vector (when content was non-empty and
//     the embedder succeeded) and threads it through
//     salience.embedding_mrl_768. R29.3 retired the deferred-embed path:
//     if the cascade could not embed because the key pool was exhausted,
//     it returns EMBED_DEFERRED upstream and promoteSourceRow is never
//     called. The vector may still be null when normalization produced
//     empty content; in that case the row lands without inline embedding
//     fields (R29.3 also retired the embedding_pending=true marker).
//
// Hermeticity: respects the same LEDGER_PATH + LEDGER_O_FLAGS + fsync
// discipline as appendFactRow. No new code-paths through nonce-store /
// policy-events; the cascade already emitted its own policy.salience.*
// events.
// ---------------------------------------------------------------------------
export async function promoteSourceRow(
  { event, source, salience },
  { now } = {},
) {
  if (event == null || typeof event !== "object") {
    throw new TypeError("promoteSourceRow: event must be an object");
  }
  if (typeof source !== "string" || source.length === 0) {
    throw new TypeError("promoteSourceRow: source must be a non-empty string");
  }
  // WU2-inline-embed-and-remove-gemini-quota-machinery: only "PROMOTE" is
  // accepted now. The cascade embeds inline via the local server, so the
  // Gemini-quota PROMOTE_WITHOUT_EMBED short-circuit is gone. On a local-
  // server outage the cascade still returns "PROMOTE" but with a null
  // embedding (salience.embedding_4096 / embedding_mrl_768 absent) →
  // embedOutput.ok===false → features.embedding=null + embed_state=true, and
  // the watermark daemon records the fact id to the re-embed sweep file.
  if (
    salience == null ||
    typeof salience !== "object" ||
    salience.decision !== "PROMOTE"
  ) {
    throw new TypeError(
      "promoteSourceRow: salience.decision must be 'PROMOTE'",
    );
  }

  // Normalize content from raw_content per source. The watermark daemon
  // already passed event through scoreCandidate (which normalizes), but
  // event is the ORIGINAL row at this call-site, so re-normalize.
  const normalized = normalizeSourceEvent({ ...event, source });
  const content =
    typeof normalized.content === "string" ? normalized.content : "";

  // consent_basis: read off the source row if present, otherwise default
  // to "third_party_inferred" to fail-safe-dampened. Connectors set this
  // at write time per kb/ingestion.md § Consent-aware promotion.
  const consentBasis =
    (event.source_policy && typeof event.source_policy.consent_basis === "string"
      ? event.source_policy.consent_basis
      : null) || "third_party_inferred";

  const sourceMsgId =
    typeof event.source_msg_id === "string" ? event.source_msg_id : null;
  const eventTs =
    typeof event.ts === "string" ? event.ts : null;

  // WU-forward-conversation-stamp (watermark path). `event` is the ORIGINAL
  // source-ledger row for this tick — it carries raw_content (chat_guid /
  // session_jid / repo_path / conversation_id ...) and ts, which is exactly
  // what deriveConversationId needs. We pass event verbatim (NOT `normalized`,
  // which strips raw_content) so the derived bucket_key matches the daemon
  // aggregator's reconstruction path byte-for-byte. Defensive: a non-thread-
  // bearing source (e.g. screentime) or a missing key returns null and the
  // field stays null, preserving the prior behavior.
  const conversationId = deriveConversationId({ ...event, source });

  // Build the args-shape appendFactRow consumes. The MCP handler's
  // args.source_refs is an array of {source, source_msg_id}; we mirror that
  // shape with the single source ref the watermark tick is processing.
  const args = {
    source_refs: sourceMsgId
      ? [{ source, source_msg_id: sourceMsgId }]
      : [{ source, source_msg_id: "watermark:unknown" }],
    content,
    derived_from: [],
    provenance: {
      agent_id: "daemons/watermark.js",
      conversation_id: conversationId,
      confidence: "pre_distilled",
    },
    // W1-CCS — F-CCS-CASCADE-row-parties-as-entities. The watermark hot
    // path reads parties directly off the source-ledger row (the cascade
    // never invented them; they are connector-authored audience metadata).
    // appendFactRow's stamp branch deduplicates against text-extracted
    // entities and silently skips when the source is not in
    // ENTITY_SOURCE_SCOPES — so unfamiliar sources (e.g. codex-cli at v0)
    // cause no errors, just no party stamps.
    parties: Array.isArray(event.parties) ? event.parties : [],
    // W2-CCS — F-CCS-CASCADE-structured-features-merge. Forward the raw
    // source row's structured_features (when present, set by an upgraded
    // connector) into args so appendFactRow can merge with the text-
    // extracted entities + time_anchors per the spec contract. Missing
    // field → text-only path stays the safe default (backwards-compat).
    structured_features:
      event && typeof event.structured_features === "object"
        ? event.structured_features
        : undefined,
    // WORKUNIT A-promote-projection — forward the source row's identity keys.
    // `event` is the ORIGINAL source-ledger row (carries raw_content with
    // chat_guid / repo_path / actor_login / conversation_id ...). appendFactRow
    // stamps the closed string-valued subset onto features.thread_keys so the
    // thread / project aggregators can bucket this NEW fact without a join back
    // to the source ledger. Empty object → stamp no-ops (back-compat).
    thread_keys: extractThreadKeysFromSourceRow(event),
    // A1 — Carry attribution through promotion (watermark hot path). `event` is
    // the ORIGINAL source-ledger row (raw_content + parties intact — the daemon
    // forwards it verbatim in its `mods.promote.promoteSourceRow({ event,
    // source, salience: sc }, { now })` call in daemons/watermark.js). Extract the bounded
    // closed-key attribution subset (sender + normalized direction) so
    // appendFactRow can stamp features.attribution; {} for non-messaging
    // sources → stamp no-ops (back-compat).
    attribution: extractAttributionFromSourceRow(event),
  };

  const consentMap = new Map();
  if (sourceMsgId) consentMap.set(sourceMsgId, consentBasis);
  else consentMap.set("watermark:unknown", consentBasis);

  // Salience features block. The cascade already produced
  // {score, components, weights_hash, version}; build the on-disk shape.
  //
  // On the null-embed PROMOTE path (empty content OR local-server outage) the
  // PROMOTE return carries score:null and no Layer-2 components, so
  // buildSalienceFeaturesBlock throws — the try/catch degrades to a row
  // without features.salience. The recall additive-only branch reads
  // features.entities + features.time_anchors, neither of which needs the
  // salience block.
  let salienceFeatures = null;
  try {
    salienceFeatures = buildSalienceFeaturesBlock(salience);
  } catch {
    salienceFeatures = null;
  }

  const nowMs =
    now instanceof Date
      ? now.getTime()
      : typeof now === "number"
        ? now
        : Date.now();
  const promotedAt = eventTs || new Date(nowMs).toISOString();

  // WU2-inline-embed-and-remove-gemini-quota-machinery: the cascade
  // (scoreCandidate) embeds inline via the local Qwen3 server and surfaces the
  // FULL 4096-dim vector on its PROMOTE return (salience.embedding_4096). We
  // use that vector directly here:
  //   - persist embedding_4096 onto the fact row (model_version stamped to
  //     ACTIVE_EMBED_MODEL_VERSION in appendFactRow)
  //   - feed it into updateIndicesForFact so the active-model HNSW + BM25 are
  //     warm post-tick
  // Layer-3 corroboration fires from the watermark hot path because every tick
  // scoreCandidate has a real vector to consult.
  //
  // Back-compat: a caller that supplies only the legacy 768-d
  // salience.embedding_mrl_768 (the Gemini-era hermetic tests, the manual MCP
  // path) still lands a row via the legacy vector_mrl_renormalized branch.
  //
  // The embedding CAN legitimately be null on the empty-content normalization
  // path (e.g. screentime rows whose raw_content lacks any embeddable field)
  // OR on a local-server outage. scoreCandidate skips embed and the row
  // PROMOTES at the novelty-0.5 floor with embedding=null + embed_state=true;
  // the watermark daemon records the fact id to the re-embed sweep file.
  const embedding4096 = Array.isArray(salience.embedding_4096)
    ? salience.embedding_4096
    : null;
  const embeddingMrl768 = Array.isArray(salience.embedding_mrl_768)
    ? salience.embedding_mrl_768
    : null;
  let embedOutput;
  if (embedding4096) {
    embedOutput = { ok: true, vector_4096: embedding4096 };
  } else if (embeddingMrl768) {
    embedOutput = {
      ok: true,
      // vector_3072 is null on this legacy path — we only carry the MRL-768d
      // vector. appendFactRow tolerates null vector_3072.
      vector_3072: null,
      vector_mrl_renormalized: embeddingMrl768,
    };
  } else {
    embedOutput = { ok: false };
  }

  let memoryEventId;
  let appendedFeatures;
  try {
    ({ memoryEventId, features: appendedFeatures } = appendFactRow(
      args,
      promotedAt,
      consentMap,
      embedOutput,
      salienceFeatures,
    ));
  } catch (err) {
    throw new Error(
      "promoteSourceRow: ledger append failed: " +
        (err && err.message ? err.message : String(err)),
    );
  }

  // R25.7 CRIT-A2: feed the new fact + vector into BM25 + HNSW so the
  // NEXT tick's scoreCandidate sees this row as a kNN neighbour. Without
  // this, the HNSW index sits at 0 entries for the entire backfill and
  // corroboration NEVER fires (the R25.6 failure mode). Failures here do
  // NOT roll back the fact row (it's already fsync'd); we log loudly and the
  // derived predicate below is the ONLY recovery affordance — the re-embed
  // sweep file receives ids whose EMBED failed, and this is the embed-SUCCESS
  // path, so no sweep entry is ever written for it (see the catch below).
  //
  // By default skip indexing when embedOutput.ok is false. The rollout flag
  // keeps BM25 warm on that path without attempting an HNSW add.
  if (embedOutput.ok === true || bm25DecoupleEmbedFlagOn()) {
    try {
      updateIndicesForFact({
        memoryEventId,
        content,
        promotedAt,
        vector_mrl_768: embeddingMrl768,
        vector_4096: embedding4096,
        consentBasis,
        // WORKUNIT A-promote-projection — project valence + entities from the
        // SAME features the row was written with.
        features: appendedFeatures,
      });
    } catch (e) {
      // Fv3-4 — the CASCADE's copy of the same residual, and the one that
      // matters most (this is the path that writes the live ledger). With
      // MEMORY_LEDGER_ROW_EMBEDDING_4096 off, an index-write failure here loses
      // the fact's 4096 vector permanently and silently: nothing on the row,
      // nothing in the WAL, and no sweep entry — the sweep file only ever
      // receives ids whose embed FAILED, and this path embedded fine. Recover
      // via embed_state===false && embedding_model_version===<active> && no
      // embedding_4096 on the row.
      console.error(
        `promoteSourceRow: index update failed for ${memoryEventId}: ${e && e.message ? e.message : String(e)}; the 4096 vector is now UNRECOVERABLE from the ledger row (MEMORY_LEDGER_ROW_EMBEDDING_4096 off) and no re-embed marker was set`,
      );
    }
  }

  return {
    ok: true,
    memory_event_id: memoryEventId,
    promoted_at: promotedAt,
  };
}

// ---------------------------------------------------------------------------
// Tool export
// ---------------------------------------------------------------------------

export const TOOL = {
  name: NAME,
  description:
    "Distillation-only. Promote a raw source event (or set of correlated events) into the memory ledger as a fact.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["source_refs", "content", "provenance", "confirmation_token"],
    properties: {
      source_refs: {
        type: "array",
        minItems: SOURCE_REFS_MIN,
        maxItems: SOURCE_REFS_MAX_PHASE1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["source", "source_msg_id"],
          properties: {
            source: { type: "string" },
            source_msg_id: { type: "string" },
          },
        },
      },
      content: { type: "string", maxLength: CONTENT_MAX_CHARS },
      derived_from: {
        type: "array",
        items: { type: "string" },
      },
      provenance: {
        type: "object",
        additionalProperties: false,
        required: ["agent_id", "conversation_id", "confidence"],
        properties: {
          agent_id: { type: "string" },
          conversation_id: { type: ["string", "null"] },
          confidence: { type: "string", enum: CONFIDENCE_ENUM },
        },
      },
      confirmation_token: { type: "string" },
    },
  },
  handler,
};

// ---------------------------------------------------------------------------
// Inline 4-line self-test (only when invoked via `node distill-promote-fact.js`)
// ---------------------------------------------------------------------------
const __isMain = (() => {
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (__isMain) {
  if (TOOL.name !== "memory_distill_promote_fact") throw new Error("name mismatch");
  if (!TOOL.inputSchema.required.includes("confirmation_token")) {
    throw new Error("schema missing confirmation_token");
  }
  console.error("distill-promote-fact self-test ok");
}

// ---------------------------------------------------------------------------
// RESIDUAL (filed by l16, NOT built here — out of scope): there is no
// reconciliation path for facts whose vector never reached the index.
//
// MEASURED STATE, so the next implementer does not re-derive it:
//   - The re-embed sweep file is an append-driven work list. Its ONLY producer
//     is appendReEmbedSweep in daemons/watermark.js, called from exactly one
//     site on the watermark promote path when embed FAILED; its only consumer
//     is daemons/reembed-drain.mjs, which reads the file by byte cursor.
//   - NOTHING enumerates ledger rows by embed_state. Every executable
//     occurrence of `embed_state === true` outside comments tree-wide is in
//     mcp/lib/recall/multi-feature-score.js, and it is a per-candidate recall
//     SCORING discriminator (it routes one candidate to the additive-only
//     branch) — it enumerates nothing and cannot serve as a work list.
//   - Consequently two populations are stranded: (a) rows landed by the MCP
//     handler / appendOperatorFact on an embed outage (embed_state=true, no
//     sweep entry), and (b) rows whose embed succeeded but whose index write
//     failed (embed_state=false, vector lost).
//
// THE MISSING ARTIFACT, by path: mcp/scripts/rebuild-embed-queue.mjs. It does
// not exist on disk. mcp/docs/specs/ccs/cascade-embedding-decoupling.md names
// it as the recovery script and explicitly calls it "future work".
//
// THE TWO PREDICATES IT NEEDS — quote these rather than re-deriving them:
//   primary (per that spec): scan memory.jsonl for features.embed_state == true
//     rows lacking a matching policy.embedding_backfill event, and re-enqueue.
//   derived (population (b), stated at the two index-failure catches above):
//     embed_state === false && embedding_model_version === <active> && no
//     vector on the row and none in the WAL.
// ---------------------------------------------------------------------------
