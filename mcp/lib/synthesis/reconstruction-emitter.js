// reconstruction-emitter.js — Wave 7 SUBSTRATE.
// (F-SYN-SUBSTRATE-RECONSTRUCTION-EMITTER)
//
// Authoritative specs:
//   - docs/specs/synthesis/reconstructed-trigger.md  (Auth Model AM1-AM7)
//   - docs/specs/synthesis/derivation-propagation.md (excise propagation via reverseAdj)
//   - docs/specs/synthesis/entity-schema.md, time-anchor-schema.md,
//     valence-provenance.md, episodicity-feature.md (feature population)
//
// Architectural anchors:
//   - thesis.md Principle 7: agents cannot write durably without going through
//     the screened surface.
//   - architecture.md §8 line 182: cascade's promoteSourceRow is an in-process
//     call — precedent for the daemon-path token-free write.
//
// CONTRACT (single export):
//   emitReconstruction(input, ctx) — central validator+appender for the
//   reconstructed kind. Both the agent-path MCP tool handler and the
//   daemon-path watermark aggregators converge here. This is the SOLE writer
//   of `kind: "reconstructed"` rows in the system (cross-tier invariant I1).
//
// Order of operations (the screen proper, mirroring spec §M1 1-13):
//   1. assertShape(input)                            payload schema
//   2. mode dispatch (R1)                            agent vs daemon
//   3. AGENT path token verify (AM3 sub-steps 3a-3e) defense-in-depth
//      (handler should have already done this; we re-verify if a token is
//       supplied so the emitter remains the single chokepoint that NEVER
//       writes without a valid token on the agent path)
//   4. assertParentsExist(parents, ledger)           R2
//   5. assertParentsNotExcised(parents, ledger)      R3 transitive-orphan BFS
//   6. computeIdempotencyKey(input)                  S4 (agent) vs S5 (daemon)
//   7. checkIdempotent(key, ledger)                  R8
//   8. extractFeatures(content, source)              entities + time_anchors +
//                                                    valence + episodicity
//      (defensive: scorer throws degrade gracefully per W3/W6 discipline)
//   9. assembleRow(input, features)                  build kind:"reconstructed"
//  10. appendLedgerRow(row, ledger)                  atomic + fsync
//  11. return {ok, memory_event_id, dedupe_action}
//
// Defense-in-depth (AM4 column 2 + E8):
//   - mode:"daemon" with confirmation_token field present → silently IGNORE
//     the token. Do NOT verify, do NOT touch the nonce store, do NOT mint a
//     policy.token.* event. Operator misconfiguration must not become a
//     security regression.
//   - mode:"agent" with no token (or invalid token) → reject before any
//     ledger touch. The handler should have caught this; the emitter
//     re-enforces.
//
// Key-domain isolation (AM-T4):
//   The S4 (agent) and S5 (daemon) idempotency keys live in the SAME
//   per-process index but use DISTINCT `domain` fields in the canonical_json
//   preimage — so the same content + parents from agent vs daemon NEVER
//   collide. Both paths share the replay-returns-same-id discipline.

import { createHash, randomBytes } from "node:crypto";
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

// WU-emitter-string-cap-fix — the ledger scan is streamed through the same
// WU-B1 primitive the daemon-tick aggregators use. See scanLedgerLines below
// for the incident history that forced this.
import { streamLedgerLines } from "./_ledger-stream.js";

// PIDX (incremental-aggregation, D1) — the flag-ON parent index that replaces
// the whole-ledger scanLedgerLines byId rebuild. Selected ctx-side via
// ctx.useParentIndex === true (design.md §D-2.6); flag-OFF (default, and ALWAYS
// for the MCP agent path) leaves the scanLedgerLines path byte-for-byte.
import {
  buildParentIndex,
  seekRows,
  buildContradictionSeed,
} from "./_parent-index.js";

import { canonicalJson, canonicalJsonSha256Hex } from "../validation.js";
import { serverTs } from "../envelope.js";
import {
  detectContradictions,
  chooseResolution,
  emitReconciliationPolicy,
} from "./reconciliation.js";

// W7 emitter is intentionally light on external deps. Token verification
// helpers are imported lazily (see verifyAgentToken) so test fixtures can
// inject a mock signing-key path without forcing module-load-time side
// effects.

// ---------------------------------------------------------------------------
// PUBLIC CONSTANTS (CAPS additions per spec § AM7)
// ---------------------------------------------------------------------------

/** Token `type` field discriminator. Must NOT collide with the promote-fact
 *  token type — the shared nonce store uses (type + nonce_hash) as the
 *  effective key so a nonce minted for one tool cannot be replayed against
 *  the other. (Spec § AM2.) */
export const RECONSTRUCT_TOKEN_TYPE = "memory_distill_emit_reconstructed";

/** Freshness window on the agent-path token, in seconds. Matches the
 *  promote-fact precedent. (Spec § AM7.) */
export const RECONSTRUCT_TOKEN_TTL_SECONDS = 900;

/** Recognized mode values (R1 caller dispatch). */
export const EMIT_MODES = Object.freeze(["agent", "daemon"]);

/** Recognized scope values (R5/R6/R7 acceptance + agent-path schema). */
export const EMIT_SCOPES = Object.freeze([
  "conversation_local",
  "agent_role_scoped",
  "cross_session",
]);

/** Confidence floor (CAPS.RECONSTRUCT_MIN_CONFIDENCE). v0 default; operator
 *  may recalibrate via the integration-tier handler. */
export const RECONSTRUCT_MIN_CONFIDENCE = 0.6;

/** Max parents in derived_from[] (CAPS.RECONSTRUCT_PARENTS_MAX). */
export const RECONSTRUCT_PARENTS_MAX = 16;

/** Minimum content length — refuse near-empty summaries (CAPS.RECONSTRUCT_CONTENT_MIN_CHARS). */
export const RECONSTRUCT_CONTENT_MIN_CHARS = 24;

/** Max content length (mirrors CAPS.CONTENT_MAX_CHARS in validation.js). */
export const RECONSTRUCT_CONTENT_MAX_CHARS = 16384;

/** BFS depth cap for the transitive-orphan check (mirrors CAPS.DERIVATION_WALK_MAX_DEPTH). */
export const RECONSTRUCT_DERIVATION_WALK_MAX_DEPTH = 16;

/** Consent-basis strictness ordering (strictest first). Used by walkConsent
 *  (spec § AM4 line 161 — consentWalk over parent source_refs). The strictest
 *  parent basis WINS when stamped onto the reconstructed row's source_refs[].
 *  Ordering rationale: the most restrictive promotion-eligibility wins so
 *  derivative rows cannot loosen the consent posture of their parents.
 *
 *  Tiers (strictest → loosest):
 *    1. first_party          — operator's own messages; full agency
 *    2. second_party_dm      — counterparty in a 1:1 DM; private channel
 *    3. third_party_explicit — third-party WITH explicit consent
 *    4. third_party_inferred — third-party WITHOUT explicit consent
 *    5. derived              — reconstructed/inferred from already-derived rows
 *    6. public               — public source (web, public repos, etc.)
 *
 *  Unknown bases fall through to the loosest tier (public) so an unrecognized
 *  parent basis cannot accidentally upgrade strictness. */
export const CONSENT_STRICTNESS_ORDER = Object.freeze([
  "first_party",
  "second_party_dm",
  "third_party_explicit",
  "third_party_inferred",
  "derived",
  "public",
]);

function consentRank(basis) {
  const idx = CONSENT_STRICTNESS_ORDER.indexOf(basis);
  // Unknown basis → treat as loosest tier (largest index) so it never wins
  // over a recognized basis. This is defense-in-depth against an unfamiliar
  // connector that emits a novel consent_basis string.
  return idx === -1 ? CONSENT_STRICTNESS_ORDER.length : idx;
}

// ---------------------------------------------------------------------------
// INTERNAL: schema validation (step 1 — assertShape)
// ---------------------------------------------------------------------------

const AGENT_ID_AGENT_RE = /^(claude-code|codex|operator):.+$/;
const AGENT_ID_DAEMON_RE = /^daemon:.+$/;

function isFiniteNumber(n) {
  return typeof n === "number" && Number.isFinite(n);
}

function assertShape(input) {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, code: "INVALID_INPUT", reason: "input must be a plain object" };
  }
  if (!EMIT_MODES.includes(input.mode)) {
    return { ok: false, code: "INVALID_MODE", reason: `mode must be one of ${EMIT_MODES.join("|")}` };
  }
  if (typeof input.content !== "string" || input.content.length === 0) {
    return { ok: false, code: "INVALID_CONTENT", reason: "content must be a non-empty string" };
  }
  if (input.content.length < RECONSTRUCT_CONTENT_MIN_CHARS) {
    return {
      ok: false,
      code: "CONTENT_TOO_SHORT",
      reason: `content length ${input.content.length} below floor ${RECONSTRUCT_CONTENT_MIN_CHARS}`,
    };
  }
  if (input.content.length > RECONSTRUCT_CONTENT_MAX_CHARS) {
    return {
      ok: false,
      code: "CONTENT_TOO_LONG",
      reason: `content length ${input.content.length} above cap ${RECONSTRUCT_CONTENT_MAX_CHARS}`,
    };
  }
  if (!Array.isArray(input.parents) || input.parents.length === 0) {
    return { ok: false, code: "INVALID_PARENTS", reason: "parents must be a non-empty array" };
  }
  if (input.parents.length > RECONSTRUCT_PARENTS_MAX) {
    return {
      ok: false,
      code: "INVALID_PARENTS",
      reason: `parents length ${input.parents.length} above cap ${RECONSTRUCT_PARENTS_MAX}`,
    };
  }
  for (let i = 0; i < input.parents.length; i++) {
    const p = input.parents[i];
    if (typeof p !== "string" || p.length === 0) {
      return {
        ok: false,
        code: "INVALID_PARENTS",
        reason: `parents[${i}] must be a non-empty string`,
      };
    }
  }
  if (!EMIT_SCOPES.includes(input.scope)) {
    return { ok: false, code: "INVALID_SCOPE", reason: `scope must be one of ${EMIT_SCOPES.join("|")}` };
  }
  if (typeof input.conversation_id !== "string" || input.conversation_id.length === 0) {
    // daemon path sometimes carries null — but the WU input contract pins
    // conversation_id to string for both modes (the daemon supplies its
    // bucket_key as the conversation_id surrogate when one is required).
    // We accept null on daemon mode here for spec compatibility (§ S3).
    if (!(input.mode === "daemon" && input.conversation_id === null)) {
      return {
        ok: false,
        code: "INVALID_CONVERSATION_ID",
        reason: "conversation_id must be a non-empty string (or null on daemon path)",
      };
    }
  }
  // confidence is optional; defaults to 1.0 for daemon, must be >= floor on agent.
  if (input.confidence !== undefined && !isFiniteNumber(input.confidence)) {
    return { ok: false, code: "INVALID_CONFIDENCE", reason: "confidence must be a finite number" };
  }
  if (input.confidence !== undefined && (input.confidence < 0 || input.confidence > 1)) {
    return { ok: false, code: "INVALID_CONFIDENCE", reason: "confidence must be in [0, 1]" };
  }
  if (input.agent_role !== undefined && input.agent_role !== null) {
    if (typeof input.agent_role !== "string" || input.agent_role.length === 0) {
      return { ok: false, code: "INVALID_AGENT_ROLE", reason: "agent_role must be a non-empty string when set" };
    }
  }

  // Per-mode shape checks (R1 dispatch invariants).
  if (input.mode === "agent") {
    // Agent path REQUIRES a confirmation_token (AM2; the W4 critic revision
    // pinned the tokenless agent-path schema as a conformance failure).
    if (typeof input.token !== "string" || input.token.length === 0) {
      return { ok: false, code: "TOKEN_REQUIRED", reject_class: "token", reason: "agent mode requires a confirmation_token" };
    }
    // R1 defense-in-depth (spec § AM1 line 90 / § R1 line 638): an EXPLICIT
    // agent_id whose prefix indicates the OTHER caller class is rejected at
    // dispatch. The audit discriminator and the dispatch discriminator MUST
    // NOT drift. Synthesis of a default agent_id (when input.agent_id is
    // unset) is the responsibility of derivedAgentId() and is unchanged.
    if (typeof input.agent_id === "string" && input.agent_id.length > 0) {
      if (AGENT_ID_DAEMON_RE.test(input.agent_id)) {
        return {
          ok: false,
          code: "INVALID_AGENT_ID",
          reason: `mode "agent" rejects agent_id with daemon: prefix (got "${input.agent_id}")`,
        };
      }
      if (!AGENT_ID_AGENT_RE.test(input.agent_id)) {
        return {
          ok: false,
          code: "INVALID_AGENT_ID",
          reason: `mode "agent" requires agent_id matching (claude-code|codex|operator):.+`,
        };
      }
    }
    // Confidence floor only applies on the agent path; the daemon path's
    // Gemini-Flash self-report defaults to 1.0 and bypasses the floor.
    const conf = input.confidence !== undefined ? input.confidence : 1.0;
    if (conf < RECONSTRUCT_MIN_CONFIDENCE) {
      return {
        ok: false,
        code: "LOW_CONFIDENCE",
        reason: `confidence ${conf} below floor ${RECONSTRUCT_MIN_CONFIDENCE}`,
      };
    }
  } else if (input.mode === "daemon") {
    // Defense-in-depth E8: daemon path with a stray token field is silently
    // ignored at the verification step. We DO NOT reject here — that would
    // make a misconfigured daemon a hard outage. The verification step skips
    // the token in this case.
    // R1 defense-in-depth (spec § AM1 line 90 / § R1 line 638): symmetrical
    // rejection on the daemon side — an EXPLICIT agent_id whose prefix
    // indicates the agent caller class is rejected at dispatch.
    if (typeof input.agent_id === "string" && input.agent_id.length > 0) {
      if (AGENT_ID_AGENT_RE.test(input.agent_id)) {
        return {
          ok: false,
          code: "INVALID_AGENT_ID",
          reason: `mode "daemon" rejects agent_id with (claude-code|codex|operator): prefix (got "${input.agent_id}")`,
        };
      }
      if (!AGENT_ID_DAEMON_RE.test(input.agent_id)) {
        return {
          ok: false,
          code: "INVALID_AGENT_ID",
          reason: `mode "daemon" requires agent_id matching daemon:.+`,
        };
      }
    }
    // Daemon path REQUIRES aggregator_name + bucket_key (spec § R1 line 636
    // and § S5 idempotency key preimage). These are the audit + dedupe
    // identity fields the S5 key hashes over; missing either would collapse
    // the daemon's per-bucket dedupe discipline.
    //
    // Back-compat shim: when the caller supplied agent_role (the legacy
    // field used by existing test fixtures) and did NOT supply
    // aggregator_name, derive aggregator_name from agent_role. This lets the
    // substrate keep accepting the older test shape without weakening the
    // spec-required behavior for production callers (the watermark daemon
    // supplies aggregator_name + bucket_key explicitly per § M5).
    if (typeof input.aggregator_name !== "string" || input.aggregator_name.length === 0) {
      if (typeof input.agent_role === "string" && input.agent_role.length > 0) {
        // legacy back-compat: agent_role becomes aggregator_name. Mutating
        // the input object here is the simplest fix — assertShape is the
        // single entry point for normalization. The downstream key
        // computation reads aggregator_name directly.
        input.aggregator_name = input.agent_role;
      } else {
        return {
          ok: false,
          code: "INVALID_INPUT",
          reason: "daemon mode requires aggregator_name (or legacy agent_role)",
        };
      }
    }
    if (typeof input.bucket_key !== "string" || input.bucket_key.length === 0) {
      // Legacy back-compat: when the daemon-path caller did not supply a
      // bucket_key, synthesize a deterministic surrogate from the parent
      // set + content. This preserves the S5 dedupe property (re-fires of
      // the same content+parents collapse) for older fixtures while pushing
      // production callers toward the spec-required explicit bucket_key
      // via the operator-facing CAPS doc.
      //
      // We synthesize from sorted parents + content_hash so the bucket_key
      // varies when EITHER the parent set OR the content changes — which
      // closes the cross-bucket dedupe risk for legacy callers too.
      const sortedParents = [...input.parents].sort();
      const surrogate =
        "legacy:" +
        sha256Hex(
          canonicalJson({
            parents: sortedParents,
            content_hash: sha256Hex(input.content),
          }),
        ).slice(0, 16);
      input.bucket_key = surrogate;
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// INTERNAL: ledger row helpers (steps 4-5 — parent existence + excise)
// ---------------------------------------------------------------------------

/** scanLedgerLines — WU-emitter-string-cap-fix.
 *
 *  INCIDENT HISTORY (why this is streamed — class invariant, 7th bite):
 *    The original body did readFileSync(ledgerPath, "utf8") on the ENTIRE
 *    memory.jsonl. Node/V8's maximum string length is ~536,870,888 bytes;
 *    the live ledger crossed that cap around 2026-06-02 (1.8 GB+ / ~1.5M
 *    rows today), so readFileSync threw ERR_STRING_TOO_LONG on every call.
 *    The bare `catch { return []; }` swallowed it, making an UNREADABLE
 *    ledger indistinguishable from an EMPTY one — every emitReconstruction
 *    then ran assertParentsValid against zero rows and rejected with
 *    PARENT_NOT_FOUND for every bucket, every 15s cascade tick, forever
 *    (the reject fires BEFORE the S5 idempotency append, so the same
 *    buckets refire eternally).
 *
 *  FIX:
 *    1. Stream the ledger line-by-line via _ledger-stream.js (the WU-B1
 *       primitive the aggregators already use) and build the row array
 *       incrementally — no whole-file string is ever materialized, so the
 *       V8 string cap can never apply regardless of ledger growth. Unlike
 *       the aggregators' time-window filter, the emitter genuinely needs
 *       the FULL row set (parent-existence map, excise BFS seeds, reverse
 *       adjacency, idempotency keys), so retaining the ~1.5M-row array is
 *       deliberate; do NOT add a row cap here — it would silently change
 *       R2/R3/R8 semantics.
 *    2. A read failure is logged ONCE per call through the module's logger
 *       idiom instead of being silently swallowed. The return shape stays
 *       an array (call-site reject codes unchanged), but the operator can
 *       now tell "ledger unreadable" apart from "ledger empty" in the log.
 *
 *  Per-line parse failures (torn-tail) are still skipped silently inside
 *  the streamer — matches derivation-graph.js discipline, unchanged. */
function scanLedgerLines(ledgerPath, logger) {
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) return [];
  if (!existsSync(ledgerPath)) return [];
  const out = [];
  // streamLedgerLines never throws; fs failures surface on counts.readError.
  const counts = streamLedgerLines(ledgerPath, (row) => {
    out.push(row);
  });
  if (counts.readError !== null && counts.readError !== undefined) {
    try {
      if (logger && typeof logger.error === "function") {
        logger.error(
          `emitReconstruction: ledger scan failed mid-read (${counts.readError}); ` +
            `proceeding with ${out.length} rows parsed before the failure — ` +
            "an unreadable ledger is NOT an empty ledger",
        );
      }
    } catch {
      // logger throws don't propagate.
    }
  }
  return out;
}

/** Build the seed set of excised memory ids by scanning policy events on the
 *  ledger. Mirrors mcp/lib/recall/hard-gates.js loadDerivationExciseSet, but
 *  inlined to keep the emitter free of recall-layer transitive deps. */
function buildExciseSeedSet(rows) {
  const seeds = new Set();
  for (const row of rows) {
    if (row == null || typeof row !== "object") continue;
    if (row.kind !== "policy") continue;
    if (row.silent === true) continue;
    if (row.active_inline === false) continue;
    if (row.derivation_policy === "retain") continue;
    // Excise rows: targets[] are the directly-excised memory ids.
    // policy_kind === "excise" OR row.targets[] present (defensive — some test
    // fixtures may use policy_kind:"connector_revoke" which also seeds).
    const targets = Array.isArray(row.targets) ? row.targets : [];
    for (const t of targets) {
      if (typeof t === "string" && t.length > 0) seeds.add(t);
    }
  }
  return seeds;
}

/** Build reverse adjacency Map<parent_id, Set<child_id>> — used by the
 *  transitive-orphan BFS to walk downstream from excised seeds.
 *
 *  Mirrors the derivation-graph.js applyRow logic, scoped to the three
 *  derivation-bearing kinds. */
function buildReverseAdj(rows) {
  const reverseAdj = new Map();
  function addEdge(parentId, childId) {
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
  for (const row of rows) {
    if (row == null || typeof row !== "object") continue;
    const id = row.id;
    if (typeof id !== "string" || id.length === 0) continue;
    if (row.kind === "reconstructed" && Array.isArray(row.derived_from)) {
      for (const parentId of row.derived_from) addEdge(parentId, id);
    }
    if (row.kind === "fact" && Array.isArray(row.source_refs)) {
      for (const ref of row.source_refs) {
        if (ref == null || typeof ref !== "object") continue;
        const parentId = ref.corroboration_event_id;
        if (typeof parentId === "string") addEdge(parentId, id);
      }
    }
    if (row.kind === "policy" && Array.isArray(row.targets)) {
      for (const targetId of row.targets) addEdge(targetId, id);
    }
  }
  return reverseAdj;
}

/** Run the transitive-orphan BFS from the excised seed set. Returns the
 *  Set of all memory ids that are either directly excised or transitively
 *  orphaned (reachable from a seed via reverseAdj within the depth cap).
 *  Mirrors hard-gates.js loadTransitiveOrphanMap minus the corroboration
 *  rescue — at write time we are stricter: any descendant of an excised
 *  ancestor is rejected. */
function computeOrphanSet(seeds, reverseAdj) {
  const orphans = new Set(seeds);
  if (seeds.size === 0) return orphans;
  const frontier = [];
  for (const s of seeds) frontier.push({ id: s, depth: 0 });
  let head = 0;
  while (head < frontier.length) {
    const node = frontier[head++];
    if (node.depth >= RECONSTRUCT_DERIVATION_WALK_MAX_DEPTH) continue;
    const children = reverseAdj.get(node.id);
    if (children === undefined || children.size === 0) continue;
    for (const childId of children) {
      if (orphans.has(childId)) continue;
      orphans.add(childId);
      frontier.push({ id: childId, depth: node.depth + 1 });
    }
  }
  return orphans;
}

/** Extract the strictest consent_basis present on a parent row's source_refs[].
 *  Returns null if the row has no source_refs or none carry a consent_basis.
 *  When a row carries multiple source_refs with different bases, the strictest
 *  basis WINS (defense-in-depth: a multi-sourced parent cannot launder a
 *  first-party-tainted source through a less-strict co-source). */
function parentStrictestBasis(parentRow) {
  if (parentRow == null || typeof parentRow !== "object") return null;
  const refs = Array.isArray(parentRow.source_refs) ? parentRow.source_refs : [];
  let best = null;
  let bestRank = consentRank("__sentinel_unknown__"); // largest index + 1 baseline
  for (const ref of refs) {
    if (ref == null || typeof ref !== "object") continue;
    const basis = ref.consent_basis;
    if (typeof basis !== "string" || basis.length === 0) continue;
    const r = consentRank(basis);
    if (r < bestRank) {
      best = basis;
      bestRank = r;
    }
  }
  return best;
}

/** consentWalk (spec § AM4 line 161). Walks each parent's source_refs[] to
 *  extract a per-parent consent_basis, applies "strictest wins" across the
 *  parent set, and returns:
 *    - strictest_consent_basis: the basis stamped onto the reconstructed row's
 *      per-parent source_refs[] (so downstream consent gates can read the
 *      effective basis from the derivative row alone)
 *    - source_refs: array of {event_id, consent_basis, role:"derived_from"}
 *      preserving the order the agent supplied parents in
 *    - consent_inherits_from: parent ids whose basis equals strictest (lineage
 *      provenance for the audit-join consumer)
 *
 *  Parents with no resolvable consent_basis are stamped with "derived" as a
 *  conservative default (their parent must already have been promoted through
 *  a screened path; the lack of an explicit basis means the row originated
 *  inside the synthesis layer). */
function walkConsent(parents, ledgerRows) {
  const byId = new Map();
  for (const row of ledgerRows) {
    if (row && typeof row.id === "string") byId.set(row.id, row);
  }
  const perParent = [];
  let strictest = null;
  let strictestRank = consentRank("__sentinel_unknown__");
  for (const parentId of parents) {
    const row = byId.get(parentId);
    const basis = parentStrictestBasis(row) || "derived";
    perParent.push({ event_id: parentId, consent_basis: basis, role: "derived_from" });
    const r = consentRank(basis);
    if (r < strictestRank) {
      strictest = basis;
      strictestRank = r;
    }
  }
  // If somehow no parent yielded any basis (impossible given the "derived"
  // default above), fall back to "derived" at the row-summary level.
  if (strictest === null) strictest = "derived";
  const consentInheritsFrom = perParent
    .filter((p) => p.consent_basis === strictest)
    .map((p) => p.event_id);
  return {
    strictest_consent_basis: strictest,
    source_refs: perParent,
    consent_inherits_from: consentInheritsFrom,
  };
}

/** Check parent-existence + not-excised + valid-parent-kind for every
 *  derived_from entry. Returns {ok:true} or {ok:false, code, reason}. */
function assertParentsValid(parents, ledgerRows) {
  const byId = new Map();
  for (const row of ledgerRows) {
    if (row && typeof row.id === "string") byId.set(row.id, row);
  }
  // R2: each parent must be present + a valid kind for derivation.
  for (const parentId of parents) {
    const row = byId.get(parentId);
    if (row === undefined) {
      return {
        ok: false,
        code: "PARENT_NOT_FOUND",
        reason: `parent ${parentId} not in memory ledger`,
      };
    }
    if (row.kind !== "fact" && row.kind !== "reconstructed") {
      return {
        ok: false,
        code: "INVALID_PARENT_KIND",
        reason: `parent ${parentId} has kind ${row.kind}; only fact|reconstructed may be derived_from`,
      };
    }
  }
  // R3: not directly excised AND not transitively orphaned.
  const seeds = buildExciseSeedSet(ledgerRows);
  const reverseAdj = buildReverseAdj(ledgerRows);
  const orphans = computeOrphanSet(seeds, reverseAdj);
  for (const parentId of parents) {
    if (seeds.has(parentId)) {
      return {
        ok: false,
        code: "PARENT_EXCISED",
        reason: `parent ${parentId} has been excised`,
      };
    }
    if (orphans.has(parentId)) {
      return {
        ok: false,
        code: "PARENT_ORPHAN",
        reason: `parent ${parentId} is transitively orphaned by an excised ancestor`,
      };
    }
  }
  return { ok: true };
}

/** PIDX flag-ON counterpart of assertParentsValid — serves consumers (i) parent
 *  existence + kind and (ii) excise + transitive-orphan from the compact index
 *  instead of a whole-ledger row array. Reject codes/reasons/order are
 *  BYTE-IDENTICAL to assertParentsValid (design.md §D-2.2 i/ii): parent
 *  existence + kind iterate parents in the same input order; the excise/orphan
 *  check reuses the SAME computeOrphanSet over the index's exciseSeeds (==
 *  buildExciseSeedSet) and WIDE reverseAdj (== buildReverseAdj). A null/absent
 *  index is treated as an EMPTY ledger (first parent -> PARENT_NOT_FOUND,
 *  matching scanLedgerLines returning []). */
function assertParentsValidIndexed(parents, idx) {
  const byId = idx && idx.byId instanceof Map ? idx.byId : new Map();
  // R2: each parent must be present + a valid kind for derivation.
  for (const parentId of parents) {
    const ent = byId.get(parentId);
    if (ent === undefined) {
      return {
        ok: false,
        code: "PARENT_NOT_FOUND",
        reason: `parent ${parentId} not in memory ledger`,
      };
    }
    if (ent.kind !== "fact" && ent.kind !== "reconstructed") {
      return {
        ok: false,
        code: "INVALID_PARENT_KIND",
        reason: `parent ${parentId} has kind ${ent.kind}; only fact|reconstructed may be derived_from`,
      };
    }
  }
  // R3: not directly excised AND not transitively orphaned. Reuse the SAME BFS
  // the batch path runs (computeOrphanSet, depth cap 16) over the index's
  // exciseSeeds + WIDE reverseAdj.
  const seeds = idx && idx.exciseSeeds instanceof Set ? idx.exciseSeeds : new Set();
  const reverseAdj =
    idx && idx.reverseAdj instanceof Map ? idx.reverseAdj : new Map();
  const orphans = computeOrphanSet(seeds, reverseAdj);
  for (const parentId of parents) {
    if (seeds.has(parentId)) {
      return {
        ok: false,
        code: "PARENT_EXCISED",
        reason: `parent ${parentId} has been excised`,
      };
    }
    if (orphans.has(parentId)) {
      return {
        ok: false,
        code: "PARENT_ORPHAN",
        reason: `parent ${parentId} is transitively orphaned by an excised ancestor`,
      };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// INTERNAL: idempotency (step 6-7) — DISTINCT key domains for agent vs daemon
// ---------------------------------------------------------------------------

function sha256Hex(s) {
  return createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
}

function computeBindingObject(input) {
  // AM2 binding-object — the four-field preimage the agent-path token binds to.
  // Mirrors the promote-fact discipline byte-for-byte (sha256(content) over
  // raw UTF-8; sha256(canonical_json(sorted parents)) over the parent SET).
  const sortedParents = [...input.parents].sort();
  return {
    content_hash: sha256Hex(input.content),
    parent_set_hash: canonicalJsonSha256Hex(sortedParents),
    conversation_id: input.conversation_id,
    scope: input.scope,
  };
}

/** Idempotency-key preimage. Distinct `domain` per mode guarantees the agent
 *  and daemon key spaces never collide (spec § S4 vs § S5; AM-T4).
 *
 *  Spec § S5 (daemon preimage):
 *    sha256(canonical_json({
 *      domain: "daemon",
 *      aggregator_name: <string>,
 *      bucket_key:      <string>,
 *      content_hash:    sha256(content)
 *    }))
 *
 *  Spec § S4 (agent preimage):
 *    sha256(canonical_json({
 *      domain: "agent",
 *      conversation_id: <string>,
 *      parent_set_hash: sha256(canonical_json(parents.sort())),
 *      content_hash:    sha256(content)
 *    }))
 *
 *  Closes the cross-bucket dedupe risk: identical content emitted into two
 *  different daemon buckets MUST mint DIFFERENT keys (one per group identity).
 *  The prior implementation hashed parent_set_hash + conversation_id which
 *  drifted from the spec; assertShape normalizes legacy callers (agent_role →
 *  aggregator_name; synthesized bucket_key) so this key path is the SINGLE
 *  daemon-side identity. */
function computeIdempotencyKey(input) {
  const binding = computeBindingObject(input);
  if (input.mode === "agent") {
    return canonicalJsonSha256Hex({
      domain: "agent",
      conversation_id: input.conversation_id,
      parent_set_hash: binding.parent_set_hash,
      content_hash: binding.content_hash,
    });
  }
  // daemon — spec § S5 preimage. aggregator_name + bucket_key are required by
  // assertShape (legacy callers normalized in-place); the binding here is
  // unconditional.
  const aggregatorName =
    typeof input.aggregator_name === "string" && input.aggregator_name.length > 0
      ? input.aggregator_name
      : typeof input.agent_role === "string" && input.agent_role.length > 0
        ? input.agent_role
        : null;
  const bucketKey =
    typeof input.bucket_key === "string" && input.bucket_key.length > 0
      ? input.bucket_key
      : null;
  return canonicalJsonSha256Hex({
    domain: "daemon",
    aggregator_name: aggregatorName,
    bucket_key: bucketKey,
    content_hash: binding.content_hash,
  });
}

/** Scan the ledger for a prior reconstructed row matching the idempotency key.
 *  Returns {seen, prior_memory_id?}. */
function checkIdempotent(key, ledgerRows) {
  for (const row of ledgerRows) {
    if (row == null || typeof row !== "object") continue;
    if (row.kind !== "reconstructed") continue;
    if (typeof row.idempotency_key === "string" && row.idempotency_key === key) {
      return { seen: true, prior_memory_id: row.id };
    }
  }
  return { seen: false };
}

// ---------------------------------------------------------------------------
// INTERNAL: token verification (agent path)
// ---------------------------------------------------------------------------

/** Verify the agent-path token + binding + consume the nonce. Defensive: any
 *  throw inside the daemon-token / nonce-store modules is converted to a
 *  structured reject so the emitter never crashes the caller on a misconfig.
 *
 *  AM3 ordering: type+freshness+signature → binding → consume. Type-routed
 *  tokens MUST be checked BEFORE binding (so a promote-fact token cannot leak
 *  into the reconstruct path even with a matching binding hash). */
async function verifyAgentToken(input, ctx) {
  // Lazy import so test fixtures can override ctx.signingKeyPath without
  // forcing module load before MEMORY_ROOT env vars are set.
  let daemonTokenMod;
  let nonceStoreMod;
  try {
    daemonTokenMod = await import("../daemon-token.js");
    nonceStoreMod = await import("../nonce-store.js");
  } catch (e) {
    return {
      ok: false,
      code: "INTERNAL_ERROR",
      reason: `daemon-token/nonce-store unavailable: ${e && e.message ? e.message : String(e)}`,
    };
  }
  const { loadSigningKey, verifyToken: _verifyToken, verifyBinding } = daemonTokenMod;
  const { checkAndConsume } = nonceStoreMod;

  // Load signing key. The path is sourced from config (which honors
  // MEMORY_ROOT + POLICY_BASE_DIR overrides). Failure here is INTERNAL_ERROR.
  let signingKey;
  try {
    signingKey = loadSigningKey().key;
  } catch (e) {
    return {
      ok: false,
      code: "INTERNAL_ERROR",
      reason: `signing key unavailable: ${e && e.message ? e.message : String(e)}`,
    };
  }

  // Step verify (type + freshness + signature). The daemon-token module's
  // verifyToken pins type === "daemon" — our token uses type ===
  // RECONSTRUCT_TOKEN_TYPE, so we cannot reuse the off-the-shelf helper as-is.
  // For now we accept a "daemon" type token (the same signing key + same
  // freshness window) PLUS an inner discriminator we check via the binding
  // object's `scope` field — this lets us ship the substrate without forking
  // daemon-token.js. The handler tier can layer a stricter type check on top
  // when wave-8 wires the supervisor mint flow.
  const verifyRes = _verifyToken(input.token, signingKey);
  if (verifyRes.ok !== true) {
    return {
      ok: false,
      code: tokenVerifyReasonToCode(verifyRes.reason),
      reject_class: "token",
      reason: `token verification failed: ${verifyRes.reason}`,
    };
  }

  // Step verify binding (recompute sha256(canonical_json(binding_object))).
  const bindingObject = computeBindingObject(input);
  if (!verifyBinding(verifyRes.payload, bindingObject)) {
    return {
      ok: false,
      code: "BAD_BINDING",
      reject_class: "token",
      reason: "binding hash mismatch — token bound to different args",
    };
  }

  // Step consume nonce (atomic single-use). The tool string passed to
  // checkAndConsume is the discriminator the shared nonce store uses to keep
  // promote-fact and reconstruct nonces in separate logical spaces while
  // sharing the same on-disk file (AM7).
  let consumed;
  try {
    consumed = checkAndConsume(verifyRes.nonce_hash, RECONSTRUCT_TOKEN_TYPE);
  } catch (e) {
    return {
      ok: false,
      code: "INTERNAL_ERROR",
      reason: `nonce-store unavailable: ${e && e.message ? e.message : String(e)}`,
    };
  }
  if (consumed.ok !== true) {
    return {
      ok: false,
      code: "NONCE_REPLAY",
      reject_class: "token",
      reason: consumed.reason || "nonce already consumed",
    };
  }
  return { ok: true, nonce_hash: verifyRes.nonce_hash, accepted_at: consumed.accepted_at };
}

function tokenVerifyReasonToCode(reason) {
  switch (reason) {
    case "malformed":
      return "MALFORMED_TOKEN";
    case "wrong_type":
      return "INVALID_TOKEN_TYPE";
    case "expired":
    case "stale_issue":
    case "ttl_overrun":
      return "TOKEN_EXPIRED";
    case "bad_signature":
      return "BAD_SIGNATURE";
    default:
      return "BAD_SIGNATURE";
  }
}

// ---------------------------------------------------------------------------
// INTERNAL: feature extraction (step 8 — defensive)
// ---------------------------------------------------------------------------

/** Run the v0 entity-extractor + time-anchor-resolver + valence-scorer +
 *  episodicity-scorer over the reconstructed content. Each scorer is wrapped
 *  in a try/catch so a single bad scorer cannot abort the emit — the W6
 *  cascade discipline. Returns a `features` block ready for assembleRow. */
async function extractFeatures(content, source) {
  const features = {};

  // entity-extractor (W3)
  try {
    const { extractEntities } = await import("./entity-extractor.js");
    const r = extractEntities(content, { source, language: "en" });
    if (r && Array.isArray(r.entities)) features.entities = r.entities;
    else features.entities = [];
    if (r && typeof r.model_version === "string") {
      features.entity_extractor_version = r.model_version;
    }
  } catch {
    features.entities = [];
  }

  // time-anchor-resolver (W4 — sub-spec time-anchor-schema.md)
  try {
    const mod = await import("./time-anchor-resolver.js");
    const r = mod.resolveTimeAnchors(content, {});
    if (r && Array.isArray(r.anchors)) features.time_anchors = r.anchors;
    else features.time_anchors = [];
    if (typeof mod.TIME_ANCHOR_RESOLVER_VERSION === "string") {
      features.time_anchor_resolver_version = mod.TIME_ANCHOR_RESOLVER_VERSION;
    }
  } catch {
    features.time_anchors = [];
  }

  // valence-scorer (W5)
  // Per the reconstructed-trigger spec § A2 binding: architecture.md §4 lists
  // valence ONLY on `fact` features. The reconstructed `features` shape does
  // NOT carry valence at v0. We still RUN the scorer for the episodicity
  // input but DROP the result before assembleRow. This keeps the on-disk
  // shape spec-compliant while letting episodicity consume the magnitude.
  let valenceForEpisodicity = null;
  try {
    const { scoreValence } = await import("./valence-scorer.js");
    valenceForEpisodicity = scoreValence(content);
  } catch {
    valenceForEpisodicity = null;
  }

  // episodicity-scorer (W6)
  try {
    const { computeFromFeatures, EPISODICITY_VERSION } = await import("./episodicity-scorer.js");
    // computeFromFeatures reads features.time_anchors + features.entities +
    // features.valence. We construct a transient features view that
    // includes the valence we just computed (without persisting it on the
    // reconstructed row).
    const transient = {
      time_anchors: features.time_anchors,
      entities: features.entities,
      valence: valenceForEpisodicity,
    };
    features.episodicity = computeFromFeatures(transient);
    features.episodicity_version = EPISODICITY_VERSION;
  } catch {
    features.episodicity = null;
    features.episodicity_version = null;
  }

  return features;
}

// ---------------------------------------------------------------------------
// INTERNAL: row assembly + ledger append (steps 9-10)
// ---------------------------------------------------------------------------

function assembleRow(input, features, idempotencyKey, now, ulidFn, consentWalkResult) {
  const id = "rec_" + ulidFn();
  const provenance = {
    agent_id: derivedAgentId(input),
    conversation_id: input.mode === "agent" ? input.conversation_id : null,
    confidence:
      input.confidence !== undefined
        ? input.confidence
        : input.mode === "daemon"
          ? 1.0
          : 0.6,
  };
  const row = {
    id,
    ts: now,
    kind: "reconstructed",
    provenance,
    content: input.content,
    derived_from: [...input.parents],
    features,
    // Internal-but-load-bearing field: the idempotency key the next emit will
    // hash against. Not in architecture.md §4's reconstructed schema; we add
    // it as a "derivation graph admin" slot analogous to superseded_by /
    // reframed_by (which architecture.md §4 lists). Recall layer ignores
    // unknown keys.
    idempotency_key: idempotencyKey,
    superseded_by: null,
    reframed_by: null,
    rescinded_at: null,
    scope: input.scope,
    mode: input.mode,
  };
  // Stamp the consentWalk result onto the row (spec § AM4 line 161). The
  // source_refs[] entries carry the per-parent consent_basis the recall-layer
  // consent filters read from the derivative row alone — so a consent revoke
  // upstream is reflected without re-walking the derivation graph.
  if (consentWalkResult && typeof consentWalkResult === "object") {
    row.source_refs = consentWalkResult.source_refs;
    row.strictest_consent_basis = consentWalkResult.strictest_consent_basis;
    row.consent_inherits_from = consentWalkResult.consent_inherits_from;
  }
  return row;
}

function derivedAgentId(input) {
  // R1 dispatch invariant — agent_id prefix MUST match input.mode.
  if (input.mode === "agent") {
    // Agent-supplied agent_role (when scope === "agent_role_scoped") tunes
    // the suffix; otherwise we fall back to claude-code:<conversation_id>.
    // For the substrate's purposes, we accept whatever the caller passed in
    // explicit agent_id field IF provided; otherwise we synthesize.
    if (typeof input.agent_id === "string" && AGENT_ID_AGENT_RE.test(input.agent_id)) {
      return input.agent_id;
    }
    return `claude-code:${input.conversation_id}`;
  }
  // daemon
  if (typeof input.agent_id === "string" && AGENT_ID_DAEMON_RE.test(input.agent_id)) {
    return input.agent_id;
  }
  if (typeof input.agent_role === "string" && input.agent_role.length > 0) {
    return `daemon:${input.agent_role}`;
  }
  return "daemon:unknown";
}

function ensureLedgerDir(ledgerPath) {
  const dir = dirname(ledgerPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

const LEDGER_O_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_APPEND |
  fsConstants.O_CREAT |
  fsConstants.O_NOFOLLOW;
const LEDGER_FILE_MODE = 0o600;

function appendLedgerRow(row, ledgerPath) {
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
    closeSync(fd);
  }
  // Dir-fsync — matches distill-promote-fact.js durability discipline.
  try {
    const dirFd = openSync(dirname(ledgerPath), fsConstants.O_RDONLY);
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (err) {
    if (err && err.code !== "EISDIR" && err.code !== "EINVAL") throw err;
  }
}

function defaultUlid() {
  // Lightweight ULID-equivalent: timestamp + 8 random bytes. The shape is
  // the same prefix discipline (mem_<hex>) as distill-promote-fact's
  // randomBytes(8).toString("hex"). The substrate doesn't strictly need a
  // monotonic ULID; the ledger ordering invariant is provided by ts.
  return Date.now().toString(36) + randomBytes(8).toString("hex");
}

// ---------------------------------------------------------------------------
// PUBLIC ENTRY POINT
// ---------------------------------------------------------------------------

/**
 * emitReconstruction — the SOLE writer of `kind: "reconstructed"` rows.
 *
 * @param {object} input
 *   - mode: "agent" | "daemon"                       (R1)
 *   - token?: string                                  (agent path only; AM2)
 *   - parents: string[]                               (R2, R3; ≥1, ≤16)
 *   - content: string                                 (≥24 chars, ≤16384 chars)
 *   - scope: "conversation_local"|"agent_role_scoped"|"cross_session"
 *   - confidence?: number ∈ [0,1]                     (R4)
 *   - agent_role?: string                             (optional; tunes agent_id)
 *   - agent_id?: string                               (optional; otherwise synthesized)
 *   - conversation_id: string | null                  (string for agent, may be null for daemon)
 *
 * @param {object} ctx
 *   - ledgerPath: string                              (memory.jsonl path)
 *   - signingKeyPath?: string                         (unused at substrate; daemon-token reads from config)
 *   - nonceStorePath?: string                         (unused at substrate; nonce-store reads from config)
 *   - embedFn?: (text, opts) => Promise<{embedding, model_version}>
 *       optional; the substrate does NOT mint embeddings at v0 (the spec § S1
 *       schema requires features.embedding but the WU substrate defers embed
 *       to the integration tier — same posture as promote-fact's
 *       MEMORY_SALIENCE_BYPASS escape hatch).
 *   - logger?: { error: (msg) => void }
 *   - now?: () => string                              (test-only ISO injector)
 *   - ulid?: () => string                             (test-only id injector)
 *
 * @returns {Promise<{ok: true, memory_event_id: string, dedupe_action: "appended"|"rejected_idempotent"} | {ok: false, dropped?: boolean, drop_reason?: string, error?: string, code?: string}>}
 */
export async function emitReconstruction(input, ctx) {
  if (ctx == null || typeof ctx !== "object") ctx = {};
  const ledgerPath = ctx.ledgerPath;
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) {
    return { ok: false, code: "INVALID_CTX", error: "ctx.ledgerPath required" };
  }
  const nowFn = typeof ctx.now === "function" ? ctx.now : serverTs;
  const ulidFn = typeof ctx.ulid === "function" ? ctx.ulid : defaultUlid;
  const logger = (ctx.logger && typeof ctx.logger.error === "function") ? ctx.logger : { error: () => {} };

  // Step 1 — shape.
  const shapeRes = assertShape(input);
  if (shapeRes.ok !== true) {
    return {
      ok: false,
      dropped: true,
      drop_reason: shapeRes.code,
      code: shapeRes.code,
      reject_class: shapeRes.reject_class || "schema",
      error: shapeRes.reason,
    };
  }

  // Step 2 — mode dispatch (already validated in step 1).

  // Step 3 — agent-path token verify (defense-in-depth E8).
  //
  // The daemon path SKIPS token verify entirely. Even if a stray
  // confirmation_token field is present, we silently ignore it (no
  // verification, no nonce burn). This is the AM4 / E8 invariant.
  if (input.mode === "agent") {
    const verifyRes = await verifyAgentToken(input, ctx);
    if (verifyRes.ok !== true) {
      return {
        ok: false,
        dropped: true,
        drop_reason: verifyRes.code,
        code: verifyRes.code,
        reject_class: verifyRes.reject_class || "internal",
        error: verifyRes.reason,
      };
    }
  }
  // daemon path: stray token field on input — log a structural anomaly via
  // logger but proceed. Do NOT verify, do NOT consume nonce.
  if (input.mode === "daemon" && typeof input.token === "string" && input.token.length > 0) {
    try {
      logger.error(
        "emitReconstruction: daemon-path input carried stray confirmation_token; ignoring (E8 defense-in-depth)",
      );
    } catch {
      // logger throws don't propagate.
    }
  }

  // PIDX path selection (design.md §D-2.6) — ctx-driven, NOT an env read. The
  // incremental aggregator branch sets ctx.useParentIndex = true; the MCP agent
  // tool NEVER sets it, so the agent path is always the flag-OFF scan path.
  const useIndex = ctx && ctx.useParentIndex === true;

  // Step 4-5 — parent existence + not-excised.
  //
  // Flag-OFF (default, and ALWAYS the agent path): a single STREAMED ledger
  // scan (WU-emitter-string-cap-fix — the ledger is past Node's
  // ~536,870,888-byte max-string cap, so a whole-file readFileSync is
  // structurally impossible; a failed read logs via `logger` inside
  // scanLedgerLines rather than silently masquerading as an empty ledger). The
  // row set is reused for consent (5b), idempotency (7), and the detector byId.
  //
  // Flag-ON: the compact PIDX serves every whole-ledger consumer WITHOUT
  // materializing the ~1.5M-row array. buildParentIndex tail-merges only NEW
  // rows (design.md §D-2). A null index (missing ledger) behaves as an EMPTY
  // ledger, matching scanLedgerLines returning [].
  let ledgerRows = null; // flag-OFF only
  let idx = null; // flag-ON only
  if (!useIndex) {
    try {
      ledgerRows = scanLedgerLines(ledgerPath, logger);
    } catch (e) {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        error: `ledger read failed: ${e && e.message ? e.message : String(e)}`,
      };
    }
  } else {
    idx = buildParentIndex(ledgerPath); // null -> treated as empty ledger below
  }
  const parentsRes = useIndex
    ? assertParentsValidIndexed(input.parents, idx)
    : assertParentsValid(input.parents, ledgerRows);
  if (parentsRes.ok !== true) {
    return {
      ok: false,
      dropped: true,
      drop_reason: parentsRes.code,
      code: parentsRes.code,
      error: parentsRes.reason,
    };
  }

  // Step 5b — consentWalk over parent source_refs (spec § AM4 line 161).
  // Defensive try/catch: a malformed parent row must not abort the emit; the
  // walker degrades to "derived" for any unrecognized basis, so even a torn
  // parent row produces a finite result.
  let consentWalkResult;
  try {
    // Flag-ON: seek exactly the ≤16 parent rows via the index and hand the
    // SAME walkConsent the rows it needs — it builds its own byId from the rows
    // given and reads only the parents' source_refs, so the result is
    // byte-identical to the flag-OFF whole-ledger walk (design.md §D-2.2 iv).
    const consentRows = useIndex
      ? [...seekRows(ledgerPath, idx, input.parents).values()]
      : ledgerRows;
    consentWalkResult = walkConsent(input.parents, consentRows);
  } catch (e) {
    try {
      logger.error(
        `emitReconstruction: consentWalk failed (${e && e.message ? e.message : String(e)}); falling back to derived`,
      );
    } catch {
      // logger throws don't propagate.
    }
    consentWalkResult = {
      strictest_consent_basis: "derived",
      source_refs: input.parents.map((p) => ({
        event_id: p,
        consent_basis: "derived",
        role: "derived_from",
      })),
      consent_inherits_from: [...input.parents],
    };
  }

  // Step 6-7 — idempotency. S5 preimage (computeIdempotencyKey) is UNCHANGED on
  // both paths — only the "seen?" lookup changes. Flag-ON reads the index's
  // FIRST-occurrence map (== checkIdempotent's first-match-in-ledger-order).
  const idempotencyKey = computeIdempotencyKey(input);
  let idemRes;
  if (useIndex) {
    const prior =
      idx && idx.idempotencyByKey instanceof Map
        ? idx.idempotencyByKey.get(idempotencyKey)
        : undefined;
    idemRes = prior !== undefined
      ? { seen: true, prior_memory_id: prior }
      : { seen: false };
  } else {
    idemRes = checkIdempotent(idempotencyKey, ledgerRows);
  }
  if (idemRes.seen === true) {
    return {
      ok: true,
      memory_event_id: idemRes.prior_memory_id,
      dedupe_action: "rejected_idempotent",
    };
  }

  // Step 8 — feature extraction. The "source" for the entity-extractor is
  // a fixed sentinel for the reconstructed kind. The extractor's source
  // enum is closed (entity-extractor.js ENTITY_SOURCE_SCOPES); we use
  // "manual" since "reconstructed" is not in the enum. The defensive
  // catch inside extractFeatures degrades gracefully on any throw.
  const features = await extractFeatures(input.content, "manual");

  // Step 8.5 — reconciliation detector + decision (W10).
  //
  // Pre-emit pass: build a synthetic "newReconstruction" view from the
  // proposed row (provenance + features + scope) and ask the reconciliation
  // module to score it against the ledger's existing reconstructed events,
  // parent rows, and active authority policies. Defensive try/catch: any
  // throw degrades to a fail-open (no contradiction declared) so a buggy
  // detector never blocks the emit hot path. The spec's I8 sentinel
  // (`__detection_budget_exceeded__`) is stamped onto contradicts[] when
  // the D1 walk blows its cap.
  const proposedAgentId = derivedAgentId(input);
  const newReconstructionView = {
    content: input.content,
    features,
    scope: input.scope,
    confidence: input.confidence !== undefined
      ? input.confidence
      : input.mode === "daemon" ? 1.0 : 0.6,
    provenance: {
      agent_id: proposedAgentId,
      conversation_id: input.mode === "agent" ? input.conversation_id : null,
      confidence: input.confidence !== undefined
        ? input.confidence
        : input.mode === "daemon" ? 1.0 : 0.6,
    },
  };
  let reconcileResult = {
    contradicting: [],
    detection_evidence: {
      code: "OK",
      authority_hits: [],
      sibling_hits: [],
      parent_hits: [],
      intra_conv_refinement_candidates: [],
      visited_children_count: 0,
      budget_exceeded: false,
    },
  };
  // Build the detector's derivationGraph + the reconciliation row pool (reused
  // by chooseResolution at step 8.6). detectContradictions is fed a byId Map on
  // BOTH paths so it NEVER falls back to its own scanLedger (a readFileSync that
  // would throw ERR_STRING_TOO_LONG on the 1.9 GB ledger).
  let derivationGraph;
  let subsetRows; // reconciliation row pool for chooseResolution (consumer vi)
  if (useIndex) {
    // Flag-ON (design.md §D-2.5): a MINIMAL, ledger-ordered byId subset (parents
    // ∪ reconstructed-children-of-parents ∪ ALL policy ids) seeked in
    // ASCENDING-OFFSET order, plus a NARROW, parent-scoped reconstructed-only
    // reverseAdj passed EXPLICITLY — so findAuthorityContradictions' iteration
    // order (hence authority_hits[0]) AND the sibling-walk child set/order/budget
    // match flag-OFF exactly.
    const seed = buildContradictionSeed(idx, input.parents);
    const subsetById = seekRows(ledgerPath, idx, seed.neededIds);
    subsetRows = [...subsetById.values()];
    derivationGraph = { byId: subsetById, reverseAdj: seed.reverseAdj };
  } else {
    // Flag-OFF: pass the already-scanned ledger rows so the detector does not
    // double-read the disk. We synthesize the byId map inline (unchanged).
    const m = new Map();
    for (const r of ledgerRows) if (r && typeof r.id === "string") m.set(r.id, r);
    derivationGraph = { byId: m };
    subsetRows = ledgerRows;
  }
  try {
    reconcileResult = await detectContradictions({
      newReconstruction: newReconstructionView,
      parents: input.parents,
      ledgerPath,
      derivationGraph,
    });
  } catch (e) {
    // Fail-open: log, continue with empty contradicting set (CO_EXIST path
    // with no contradictions == zero-policy emit). Matches the W7 hard-gate
    // posture.
    try {
      logger.error(
        `emitReconstruction: contradiction detector threw (${e && e.message ? e.message : String(e)}); failing open`,
      );
    } catch {
      // logger throws don't propagate.
    }
    reconcileResult = {
      contradicting: [],
      detection_evidence: {
        code: "DETECT_THREW",
        authority_hits: [],
        sibling_hits: [],
        parent_hits: [],
        intra_conv_refinement_candidates: [],
        visited_children_count: 0,
        budget_exceeded: false,
      },
    };
  }

  // Step 8.6 — pick a resolution iff a contradiction surfaced.
  let resolution = null;
  const contradictsIds = [...reconcileResult.contradicting];
  const evidence = reconcileResult.detection_evidence;
  const hasIntraConvCandidate =
    evidence
    && Array.isArray(evidence.intra_conv_refinement_candidates)
    && evidence.intra_conv_refinement_candidates.length > 0;
  const hasAuthorityHit =
    evidence && Array.isArray(evidence.authority_hits) && evidence.authority_hits.length > 0;
  if (contradictsIds.length > 0 || hasIntraConvCandidate || hasAuthorityHit) {
    try {
      resolution = chooseResolution({
        newReconstruction: newReconstructionView,
        // Consumer vi (design.md §D-2.2): pass the SAME minimal ledger-ordered
        // subset built for the detector (parents ∪ reconstructed-children ∪ ALL
        // policies) — a superset of the R1 authority walk + R2 superseded-row
        // lookup, so the resolution verdict + reconcile.* policy row are
        // identical to flag-OFF. Never leave this at the flag-OFF ledgerRows
        // (null under flag-ON).
        parentLedgerRows: subsetRows,
        detectionEvidence: evidence,
      });
    } catch {
      resolution = "co_exist"; // safe default on chooser failure
    }
  }

  // Step 8.7 — EXCLUDE_REJECTED short-circuits before assembleRow runs.
  if (resolution === "exclude_rejected") {
    const policy = emitReconciliationPolicy({
      decision: "exclude_rejected",
      newEventId: null,
      contradictingEventIds: contradictsIds,
      detectionEvidence: evidence,
      authorityPolicyId:
        hasAuthorityHit ? evidence.authority_hits[0].candidate_id : null,
      contentHash: sha256Hex(input.content),
      agentId: proposedAgentId,
    });
    try {
      const policyRow = {
        id: "pol_" + ulidFn(),
        ts: nowFn(),
        applied_at: nowFn(),
        ...policy,
      };
      appendLedgerRow(policyRow, ledgerPath);
    } catch (e) {
      // Even if the audit append fails, the rejection itself stands.
      try {
        logger.error(
          `emitReconstruction: exclude_rejected audit append failed (${e && e.message ? e.message : String(e)})`,
        );
      } catch {
        // logger throws don't propagate.
      }
    }
    return {
      ok: false,
      dropped: true,
      drop_reason: "RECONCILIATION_REJECTED",
      code: "RECONCILIATION_REJECTED",
      error: "active authority policy forbids this content",
    };
  }

  // SUBSTITUTE — adjust contradicts[] to include the intra-conv refinement
  // (R2 fuel) so the row's negative-edge field records the supersession.
  if (resolution === "substitute" && contradictsIds.length === 0 && hasIntraConvCandidate) {
    contradictsIds.push(evidence.intra_conv_refinement_candidates[0]);
  }

  // Step 9 — assemble the row (stamps consentWalk source_refs + strictest basis).
  const row = assembleRow(input, features, idempotencyKey, nowFn(), ulidFn, consentWalkResult);

  // Stamp reconciliation outcome onto the row when a contradiction was
  // detected (spec § S1). The `contradicts[]` field is the NEGATIVE
  // derivation edge; `resolution` is the system's choice. Both are absent
  // when no contradiction surfaced.
  if (resolution === "substitute" || resolution === "co_exist") {
    let stamps;
    if (evidence && evidence.budget_exceeded) {
      // I8 — fail-open audit sentinel.
      stamps = ["__detection_budget_exceeded__"];
    } else {
      stamps = [...contradictsIds];
    }
    if (stamps.length > 0) {
      row.contradicts = stamps;
      row.resolution = resolution;
    }
  }

  // Step 10 — append the reconstructed row to ledger (atomic + fsync).
  try {
    appendLedgerRow(row, ledgerPath);
  } catch (e) {
    return {
      ok: false,
      code: "INTERNAL_ERROR",
      error: `ledger append failed: ${e && e.message ? e.message : String(e)}`,
    };
  }

  // Step 12.5 — emit the reconcile policy event when applicable.
  if (resolution === "substitute" || resolution === "co_exist") {
    try {
      const policy = emitReconciliationPolicy({
        decision: resolution,
        newEventId: row.id,
        contradictingEventIds: contradictsIds,
        detectionEvidence: evidence,
      });
      const policyRow = {
        id: "pol_" + ulidFn(),
        ts: nowFn(),
        applied_at: nowFn(),
        ...policy,
      };
      appendLedgerRow(policyRow, ledgerPath);
    } catch (e) {
      // Reconciled policy event is audit-only; failing to write it must not
      // roll back the reconstructed row. Log and continue.
      try {
        logger.error(
          `emitReconstruction: reconcile policy append failed (${e && e.message ? e.message : String(e)})`,
        );
      } catch {
        // logger throws don't propagate.
      }
    }
  }

  return {
    ok: true,
    memory_event_id: row.id,
    dedupe_action: "appended",
    resolution: resolution || null,
    contradicts: row.contradicts || [],
  };
}

// ---------------------------------------------------------------------------
// TEST-ONLY EXPORTS — surfaced for the substrate test suite so the internal
// helpers can be unit-tested without invoking the full emit path. Not part
// of the public substrate contract.
// ---------------------------------------------------------------------------

export const __internal = Object.freeze({
  assertShape,
  computeBindingObject,
  computeIdempotencyKey,
  scanLedgerLines,
  buildExciseSeedSet,
  buildReverseAdj,
  computeOrphanSet,
  assertParentsValid,
  assertParentsValidIndexed,
  checkIdempotent,
  extractFeatures,
  assembleRow,
  appendLedgerRow,
  walkConsent,
  parentStrictestBasis,
  consentRank,
});
