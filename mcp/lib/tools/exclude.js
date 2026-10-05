/** memory_exclude — see kb/mcp-surface.md § memory_exclude. */

import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { POLICY_DIR, memoryLedgerPath } from "../config.js";
import { ok, serverTs } from "../envelope.js";
import { ERROR_CODES, ToolError } from "../error-codes.js";
import { lookupRecall } from "../recall-log.js";
import { propagateForgettingThroughSynthesis } from "../synthesis/forgetting-propagation.js";
import {
  CAPS,
  assertNonEmptyString,
  assertNumberInRange,
  assertObject,
  assertObjectShape,
  assertOptionalString,
  assertStringArray,
  canonicalJson,
} from "../validation.js";

const NAME = "memory_exclude";

// In-process registry of active predicates. Cross-imported by get-predicate.js,
// list-predicates.js, and rescind-policy.js for Phase 0 introspection.
//
// PERSISTENCE (B1a2): every emitted predicate is ALSO appended as a
// dimension-tagged JSONL row to POLICY_DIR/predicates.jsonl BEFORE it is
// registered here — that file is what loadActivePredicates
// (mcp/lib/recall/hard-gates.js) reads on every recall, so a predicate that
// fails to persist must fail loud rather than register a phantom in-memory
// success that would never reach the gate (or survive restart).
// RESCIND PERSISTENCE (B1a2b): rescind-policy.js appends an { predicate_id,
// active:false, rescinded_at, emitted_by } tombstone through
// appendPredicateRow below BEFORE flipping this Map; the loader's
// last-write-wins collapse retires the predicate at the gate.
// HYDRATION (B1a2b): this Map is seeded from predicates.jsonl at module init
// (same normalization/collapse as loadActivePredicates), so after a restart
// countActive(), findDuplicateActive(), memory_list_predicates,
// memory_get_predicate, and the rescind lookup all see disk state — and the
// PREDICATE_MAX_ACTIVE cap counts the collapsed active set on disk, not just
// this process's emissions.
//
// Concurrency stance: each persist is a single one-line append; predicate
// emission is human-paced and rare, so interleaved appends are not a
// practical concern. A torn line degrades to the loader's loud per-line
// skip, which OVER-surfaces: the exclusion stops gating and the memory the
// user asked to hide comes back until the predicate is re-emitted. That
// failure is visible (console.error per recall), never silent.
export const activePredicates = new Map();

const PREDICATES_FILE_MODE = 0o600;

function predicatesFilePath() {
  return join(POLICY_DIR, "predicates.jsonl");
}

// Shared persist seam for exclude emission and rescind tombstones
// (rescind-policy.js imports this). Append-only, one JSON line per call.
// The file is held at 0600 like its sibling policy files (recall-log.js
// LEDGER_FILE_MODE, policy-events.js): rows carry conversation_id,
// rationale, and the full query embedding. Throws raw fs errors; callers
// wrap in ToolError(INTERNAL_ERROR) so a persist failure is loud and
// nothing registers in-memory that never reached disk.
export function appendPredicateRow(row) {
  mkdirSync(POLICY_DIR, { recursive: true, mode: 0o700 });
  const path = predicatesFilePath();
  const fd = openSync(path, "a", PREDICATES_FILE_MODE);
  try {
    appendFileSync(fd, JSON.stringify(row) + "\n");
  } finally {
    closeSync(fd);
  }
  // openSync's mode only applies at creation; repair files created before
  // B1a2b at the 0644 default.
  chmodSync(path, PREDICATES_FILE_MODE);
}

// Seed the in-process registry from predicates.jsonl (module init only —
// never on a request path). Mirrors loadActivePredicates' normalization and
// last-write-wins collapse: rows the gate loader would skip (inert vectors,
// inconsistent dim tags) can never gate, so they must not count toward the
// cap or dedup either. Tombstones are RETAINED as active:false entries so a
// rescinded predicate stays introspectable via memory_get_predicate after a
// restart, and re-rescind stays idempotent instead of NOT_FOUND.
function hydrateActivePredicatesFromDisk() {
  const path = predicatesFilePath();
  if (!existsSync(path)) return;
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    // Loud but non-fatal: the gate still reads the file itself per recall;
    // only cap/dedup/introspection undercount until the operator intervenes.
    console.error(`memory_exclude: failed to hydrate from ${path}: ${err.message}`);
    return;
  }
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      console.error(
        `memory_exclude: predicates.jsonl line ${i + 1} is not valid JSON; skipping during hydration`,
      );
      continue;
    }
    if (row == null || typeof row !== "object") continue;
    if (typeof row.predicate_id !== "string") continue;

    if (row.active === false) {
      const existing = activePredicates.get(row.predicate_id);
      if (existing != null) {
        existing.active = false;
        existing.rescinded_at = row.rescinded_at ?? existing.rescinded_at ?? null;
      } else {
        activePredicates.set(row.predicate_id, {
          policy_kind: typeof row.policy_kind === "string" ? row.policy_kind : "exclude",
          predicate_id: row.predicate_id,
          captured_at: null,
          emitted_by: row.emitted_by ?? null,
          context_entities: [],
          similarity_threshold: null,
          scope: null,
          rationale: null,
          recall_id: null,
          embedding_snapshot: {
            context_embedding: [],
            embedding_model_version: null,
          },
          active: false,
          rescinded_at: row.rescinded_at ?? null,
        });
      }
      continue;
    }
    if (row.active !== true) continue;

    // Vector normalization mirrors loadActivePredicates (hard-gates.js).
    let queryEmbedding;
    if (Array.isArray(row.query_embedding)) {
      if (
        !Number.isInteger(row.embedding_dim) ||
        row.embedding_dim < 1 ||
        row.query_embedding.length !== row.embedding_dim
      ) {
        continue; // gate loader skips this row — it never gates, never counts
      }
      queryEmbedding = row.query_embedding;
    } else if (
      Array.isArray(row.query_embedding_3072) &&
      row.query_embedding_3072.length >= 1
    ) {
      queryEmbedding = row.query_embedding_3072;
    } else {
      continue;
    }

    activePredicates.set(row.predicate_id, {
      policy_kind: typeof row.policy_kind === "string" ? row.policy_kind : "exclude",
      predicate_id: row.predicate_id,
      captured_at: row.captured_at ?? null,
      emitted_by: row.emitted_by ?? null,
      context_entities: Array.isArray(row.context_entities) ? row.context_entities : [],
      similarity_threshold:
        typeof row.similarity_threshold === "number" ? row.similarity_threshold : null,
      scope: row.scope ?? null,
      rationale: typeof row.rationale === "string" ? row.rationale : null,
      recall_id: typeof row.recall_id === "string" ? row.recall_id : null,
      embedding_snapshot: {
        context_embedding: queryEmbedding,
        embedding_model_version: row.embedding_model_version ?? null,
      },
      active: true,
    });
  }
}
hydrateActivePredicatesFromDisk();

function validateScope(scope) {
  if (scope === "global") return "global";
  if (scope == null || typeof scope !== "object" || Array.isArray(scope)) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `predicate.scope must be "global" or an object`,
    );
  }
  assertObjectShape(scope, "predicate.scope", ["agent_role", "parties", "time_range"]);
  // FAIL-CLOSED on the authz-NARROWING dims (parties, time_range). The match
  // layer cannot yet enforce them: honoring a party/time-scoped exclusion
  // requires threading the recall request's agent_role / parties / time through
  // recall.js -> applyHardGates, which lives OUTSIDE this node's file allowlist
  // (followup: honor-scope-authz). Persisting a predicate whose narrowing
  // semantics recall ignores is the WORST state — the exclusion would silently
  // act GLOBAL instead of within its intended slice. So we reject at the tool
  // boundary rather than persist-and-ignore. NOTE: match also does NOT yet
  // enforce agent_role scope — the accepted { agent_role } / {} Phase-0 form is
  // recorded for audit and future enforcement, but currently gates globally;
  // scope:"global" itself stays token-gated (PRIVILEGE_REQUIRED in Phase 0).
  if (scope.parties != null) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `predicate.scope.parties is not yet enforced at recall (deferred-enforcement: honor-scope-authz); omit it — an unenforced authz-narrowing scope would silently act GLOBAL`,
    );
  }
  if (scope.time_range != null) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `predicate.scope.time_range is not yet enforced at recall (deferred-enforcement: honor-scope-authz); omit it — an unenforced authz-narrowing scope would silently act GLOBAL`,
    );
  }
  assertOptionalString(scope.agent_role, "predicate.scope.agent_role");
  return scope;
}

function countActive() {
  let n = 0;
  for (const p of activePredicates.values()) {
    if (p.active) n += 1;
  }
  return n;
}

// Two active predicates are considered identical if they share the same
// recall_id, the same scope (deep), the same similarity_threshold, and the
// same context_entities set. Duplicate emission returns STATE_CONFLICT so the
// agent does not silently accrue redundant predicates against
// PREDICATE_MAX_ACTIVE. Rescinded predicates do not block dedup — re-emit
// is the intended path after rescind.
function findDuplicateActive(recallId, scope, threshold, entities) {
  // Stable comparison uses canonical_json (RFC 8785 JCS). JSON.stringify
  // preserves caller-side insertion order so two semantically-identical scopes
  // built with different key orders would compare unequal (dedup false
  // negative). Joining entities on a null byte avoided some edge cases but
  // still relied on entity content not containing the delimiter; canonical_json
  // on a sorted array is delimiter-safe regardless.
  const entitiesKey = canonicalJson([...entities].sort());
  const scopeKey = typeof scope === 'string' ? scope : canonicalJson(scope);
  for (const p of activePredicates.values()) {
    if (!p.active) continue;
    if (p.recall_id !== recallId) continue;
    if (p.similarity_threshold !== threshold) continue;
    const pScopeKey = typeof p.scope === 'string' ? p.scope : canonicalJson(p.scope);
    if (pScopeKey !== scopeKey) continue;
    const pEntitiesKey = canonicalJson([...p.context_entities].sort());
    if (pEntitiesKey !== entitiesKey) continue;
    return p;
  }
  return null;
}

async function handler(args) {
  assertObjectShape(args, "args", [
    "recall_id",
    "predicate",
    "confirmation_token",
    "conversation_id",
    "agent_role",
    "rationale",
  ]);

  const recallId = assertNonEmptyString(args.recall_id, "recall_id");

  const predicate = assertObject(args.predicate, "predicate");
  assertObjectShape(predicate, "predicate", [
    "context_entities",
    "similarity_threshold",
    "scope",
  ]);
  const entities = assertStringArray(predicate.context_entities, "predicate.context_entities", {
    maxItems: CAPS.PREDICATE_MAX_ENTITIES,
  });
  assertNumberInRange(predicate.similarity_threshold, "predicate.similarity_threshold", {
    min: 0.0,
    max: 1.0,
  });
  const scope = validateScope(predicate.scope);

  assertOptionalString(args.confirmation_token, "confirmation_token");
  assertNonEmptyString(args.conversation_id, "conversation_id");
  assertNonEmptyString(args.agent_role, "agent_role");
  const rationale = assertOptionalString(args.rationale, "rationale", {
    maxChars: CAPS.RATIONALE_CHARS,
  });

  // Global scope requires a user-issued confirmation token. Token issuance
  // ships in Phase 2; in Phase 0 we reject unconditionally
  // (kb/mcp-surface.md § memory_exclude > Phase availability).
  if (scope === "global") {
    throw new ToolError(
      ERROR_CODES.PRIVILEGE_REQUIRED,
      `scope: "global" requires a user-issued confirmation token; token issuance ships in Phase 2`,
    );
  }

  // Server snapshots context_embedding + embedding_model_version from the
  // logged recall event. The agent does not supply the embedding — it passes
  // only the recall_id. Missing or expired recall_id => NOT_FOUND.
  const recallEntry = lookupRecall(recallId);
  if (recallEntry == null) {
    throw new ToolError(
      ERROR_CODES.NOT_FOUND,
      `recall_id "${recallId}" not found or expired beyond RECALL_LOG_TTL_SECONDS`,
    );
  }

  // Duplicate detection: identical predicate against the same recall_id is
  // STATE_CONFLICT, not a fresh insert. Same finding the user wants enforced
  // by the third smoke assertion in spec-5.
  const existing = findDuplicateActive(recallId, scope, predicate.similarity_threshold, entities);
  if (existing != null) {
    throw new ToolError(
      ERROR_CODES.STATE_CONFLICT,
      `predicate identical to active predicate_id ${existing.predicate_id} (recall_id, scope, threshold, entities all match)`,
      { existing_predicate_id: existing.predicate_id },
    );
  }

  // PREDICATE_MAX_ACTIVE cap. Rescind to make room. countActive() runs over
  // the hydrated registry, so it reflects the collapsed active set ON DISK
  // (prior-process emissions included), not just this process's Map — the
  // file can therefore never exceed the cap and trip the gate loader's
  // silent pass-2 truncation.
  if (countActive() >= CAPS.PREDICATE_MAX_ACTIVE) {
    throw new ToolError(
      ERROR_CODES.STATE_CONFLICT,
      `PREDICATE_MAX_ACTIVE (${CAPS.PREDICATE_MAX_ACTIVE}) reached; rescind a predicate before emitting a new one`,
    );
  }

  const predicateId = "pred_stub_" + randomBytes(4).toString("hex");
  const appliedAt = serverTs();
  const embeddingModelVersion = recallEntry.query?.embedding_model_version ?? "stub-0.0.1";
  const contextEmbedding = recallEntry.query?.context_embedding;

  // B1a2b: a recall entry without a usable query embedding (degraded/BM25-only
  // recall) cannot anchor an exclusion — the gate compares the snapshotted
  // vector against candidate embeddings, so a dim-0 predicate could NEVER
  // gate. Persisting it anyway would be the exact silent-no-op class B1a2
  // exists to kill (ok:true, inert durable row, loader console.error on every
  // recall forever). Reject loudly BEFORE persist and Map.set.
  if (!Array.isArray(contextEmbedding) || contextEmbedding.length < 1) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `recall_id "${recallId}" carried no query embedding (degraded/BM25-only recall), so an exclusion bound to it could never gate; re-run memory_recall on the embedding path and bind the exclude to that recall_id`,
    );
  }

  // Persist BEFORE registering in-memory. The gate loader
  // (loadActivePredicates in mcp/lib/recall/hard-gates.js) reads this file
  // fresh on every recall; the row is dimension-tagged (embedding_dim) so the
  // gate evaluates in the predicate's own vector geometry. A persist failure
  // throws INTERNAL_ERROR before Map.set — no phantom success for an
  // exclusion that would not survive restart or ever reach the gate.
  const persistedRow = {
    policy_kind: "exclude",
    predicate_id: predicateId,
    active: true,
    captured_at: appliedAt,
    emitted_by: {
      conversation_id: args.conversation_id,
      agent_role: args.agent_role,
    },
    context_entities: entities,
    similarity_threshold: predicate.similarity_threshold,
    scope,
    rationale,
    recall_id: recallId,
    query_embedding: contextEmbedding,
    embedding_dim: contextEmbedding.length,
    embedding_model_version: embeddingModelVersion,
  };
  try {
    appendPredicateRow(persistedRow);
  } catch (err) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `failed to persist predicate to predicates.jsonl: ${err.message}`,
    );
  }

  activePredicates.set(predicateId, {
    policy_kind: "exclude",
    predicate_id: predicateId,
    captured_at: appliedAt,
    emitted_by: {
      conversation_id: args.conversation_id,
      agent_role: args.agent_role,
    },
    context_entities: entities,
    similarity_threshold: predicate.similarity_threshold,
    scope,
    rationale,
    recall_id: recallId,
    embedding_snapshot: {
      context_embedding: contextEmbedding,
      embedding_model_version: embeddingModelVersion,
    },
    active: true,
  });

  // W11 forgetting-propagation — emit a policy.derivation.cascade_orphan
  // row for every memory id named in context_entities[] (the operator's
  // forget-this-fact handle). The call is FIRE-AND-FORGET: a graph load
  // failure, ledger write throw, or any other propagation error MUST NOT
  // back-propagate to the agent — the predicate has already been
  // registered and is the authoritative "stop bringing up X" gate. The
  // cascade event is the audit trail; absence of one means the lazy
  // recall-time orphan gate (W8) handles dampening. See
  // docs/specs/synthesis/derivation-propagation.md § EXCISE channel.
  try {
    const ledgerPath = memoryLedgerPath();
    for (const memoryId of entities) {
      // Each entity is treated as a candidate memory_id to cascade from.
      // No await — fire-and-forget. We do NOT chain a .catch() because
      // propagateForgettingThroughSynthesis already swallows its own
      // throws (defensive degradation). The Promise is intentionally
      // unawaited; the test surface drives the function directly.
      propagateForgettingThroughSynthesis({
        excisedMemoryId: memoryId,
        ledgerPath,
      });
    }
  } catch {
    // The synchronous path here is just memoryLedgerPath() + a loop —
    // a throw would be a config bug. Swallow defensively so the exclude
    // handler returns success regardless of propagation health.
  }

  return ok(NAME, {
    predicate_id: predicateId,
    applied_at: appliedAt,
    embedding_model_version: embeddingModelVersion,
    scope_applied: scope,
    active_predicates_count: countActive(),
  });
}

export const TOOL = {
  name: NAME,
  description:
    "Hide memories matching a predicate in matching contexts. Use for 'stop bringing up X' and contextual suppression. Bound to a prior recall_id; the embedding is server-snapshotted, never caller-supplied.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["recall_id", "predicate", "conversation_id", "agent_role"],
    properties: {
      recall_id: { type: "string" },
      predicate: {
        type: "object",
        additionalProperties: false,
        required: ["context_entities", "similarity_threshold", "scope"],
        properties: {
          context_entities: {
            type: "array",
            items: { type: "string" },
            maxItems: CAPS.PREDICATE_MAX_ENTITIES,
          },
          similarity_threshold: { type: "number", minimum: 0, maximum: 1 },
          scope: {
            oneOf: [
              { type: "string", enum: ["global"] },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  agent_role: { type: "string" },
                  parties: { type: "array", items: { type: "string" } },
                  time_range: {
                    type: "object",
                    additionalProperties: false,
                    required: ["start", "end"],
                    properties: {
                      start: { type: "string" },
                      end: { type: "string" },
                    },
                  },
                },
              },
            ],
          },
        },
      },
      confirmation_token: { type: "string" },
      conversation_id: { type: "string" },
      agent_role: { type: "string" },
      rationale: { type: "string", maxLength: CAPS.RATIONALE_CHARS },
    },
  },
  handler,
};
