/** memory_distill_emit_reconstructed — agent-callable reconstruction emission.
 *
 * Phase 3 / Wave 8 integration tier. Mirrors distill-promote-fact.js
 * discipline (the existing precedent for "screened MCP tool that calls into a
 * substrate via a daemon-signed token") but delegates the heavy lifting to
 * the W7 substrate (mcp/lib/synthesis/reconstruction-emitter.js).
 *
 * Authoritative specs:
 *   - docs/specs/synthesis/reconstructed-trigger.md § Auth Model AM1–AM7
 *   - nodes/F-SYN-INTEGRATION-RECONSTRUCTED-MCP-TOOL.json
 *   - thesis.md Principle 7 (narrow privileged surface)
 *
 * Handler step ordering (maps to spec § AM3 + the promote-fact precedent):
 *   step 1: scope            — dispatch.js (MEMORY_ROLE != "distillation").
 *                              DISTILLATION_ONLY_TOOLS already pre-declares
 *                              this name (mcp/lib/dispatch.js line 47); the
 *                              handler trusts that and never re-checks role.
 *   step 2: payload shape    — assertObjectShape + per-field asserts. Unknown
 *                              keys are rejected (mirrors promote-fact).
 *   step 3: compute binding  — {content_hash, parent_set_hash,
 *                              conversation_id, scope}. The substrate
 *                              recomputes this from input independently and
 *                              compares to token.binding_hash; the handler
 *                              still validates payload shape here.
 *   step 4: TOKEN VERIFY     — DELEGATED to the substrate. The substrate's
 *                              verifyAgentToken() runs verifyToken →
 *                              verifyBinding → checkAndConsume (the same
 *                              5-step sequence promote-fact uses, AM3).
 *                              Failures surface as {ok:false, code, error}
 *                              which we marshal into the error envelope.
 *   step 5: EMIT             — emitReconstruction({mode: "agent", ...}, ctx).
 *                              Substrate runs the structural screen (parents
 *                              exist, not excised, not transitive-orphan,
 *                              idempotency, feature extraction, fsync'd
 *                              append) and returns memory_event_id on
 *                              success or {ok:false, code, error} on reject.
 *   step 6: audit            — emit policy.token.consumed on the success
 *                              path so the supervisor's mint/consume audit
 *                              trail closes (matches promote-fact step 5).
 *                              On token-reject we emit policy.token.rejected.
 *                              On structural reject (PARENT_NOT_FOUND etc.)
 *                              the nonce is already burned by the substrate;
 *                              we still emit policy.token.consumed because
 *                              "nonce stays consumed on consent_blocked"
 *                              (promote-fact line 30) is the load-bearing
 *                              discipline this tool also inherits.
 *
 * Envelope contract (see lib/envelope.js):
 *   success → {ok:true, data:{memory_event_id, dedupe_action, dropped?,
 *              drop_reason?}, error:null, meta}
 *   reject  → {ok:false, data:null, error:{code, message, details?}, meta}
 *
 * Token discipline:
 *   The supervisor mints the token (one token = one nonce = one emission)
 *   BEFORE invoking this handler. The token type field is
 *   RECONSTRUCT_TOKEN_TYPE ("memory_distill_emit_reconstructed"); the shared
 *   nonce store uses (type + nonce_hash) so a promote-fact nonce cannot be
 *   replayed against this tool (AM2 + AM7). Per the substrate's lazy import,
 *   the off-the-shelf verifyToken still accepts the canonical "daemon" type
 *   token — the supervisor-side type upgrade lands when the supervisor mint
 *   table is extended (see review issue MINOR in the node JSON).
 */

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { ok, error as errEnv, serverTs } from "../envelope.js";
import { ERROR_CODES, ToolError } from "../error-codes.js";
import {
  assertEnum,
  assertNonEmptyString,
  assertObjectShape,
  assertOptionalStringArray,
  canonicalJsonSha256Hex,
  CONTENT_MAX_CHARS,
} from "../validation.js";
import { appendPolicyEvent } from "../policy-events.js";
import { memoryLedgerPath } from "../config.js";
import {
  emitReconstruction,
  EMIT_SCOPES,
  RECONSTRUCT_PARENTS_MAX,
  RECONSTRUCT_CONTENT_MIN_CHARS,
  RECONSTRUCT_MIN_CONFIDENCE,
} from "../synthesis/reconstruction-emitter.js";

const NAME = "memory_distill_emit_reconstructed";

// Per-call caps. parents min/max mirror the substrate (R2 + RECONSTRUCT_PARENTS_MAX).
const PARENTS_MIN = 1;
const PARENTS_MAX = RECONSTRUCT_PARENTS_MAX;

// ---------------------------------------------------------------------------
// Payload validation (handler step 2)
// ---------------------------------------------------------------------------

function validatePayload(args) {
  assertObjectShape(args, "args", [
    "parents",
    "content",
    "scope",
    "confidence",
    "agent_role",
    "conversation_id",
    "confirmation_token",
  ]);
  // parents — non-empty string array, bounded [PARENTS_MIN, PARENTS_MAX].
  if (!Array.isArray(args.parents)) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      "parents must be an array",
    );
  }
  if (args.parents.length < PARENTS_MIN) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `parents must contain at least ${PARENTS_MIN} entry`,
    );
  }
  if (args.parents.length > PARENTS_MAX) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `parents exceeds max ${PARENTS_MAX} entries`,
    );
  }
  args.parents.forEach((p, i) => {
    assertNonEmptyString(p, `parents[${i}]`);
  });
  // content — non-empty string within [RECONSTRUCT_CONTENT_MIN_CHARS, CONTENT_MAX_CHARS].
  assertNonEmptyString(args.content, "content", { maxChars: CONTENT_MAX_CHARS });
  if (args.content.length < RECONSTRUCT_CONTENT_MIN_CHARS) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `content length ${args.content.length} below floor ${RECONSTRUCT_CONTENT_MIN_CHARS}`,
    );
  }
  // scope — one of the substrate's recognized scopes.
  assertEnum(args.scope, EMIT_SCOPES, "scope");
  // confidence — optional number in [0,1]; floor enforced at the substrate
  // (LOW_CONFIDENCE) but caught here too to fail fast.
  if (args.confidence !== undefined && args.confidence !== null) {
    if (typeof args.confidence !== "number" || !Number.isFinite(args.confidence)) {
      throw new ToolError(
        ERROR_CODES.INVALID_ARGUMENTS,
        "confidence must be a finite number",
      );
    }
    if (args.confidence < 0 || args.confidence > 1) {
      throw new ToolError(
        ERROR_CODES.INVALID_ARGUMENTS,
        "confidence must be in [0, 1]",
      );
    }
  }
  // agent_role — optional non-empty string.
  if (args.agent_role !== undefined && args.agent_role !== null) {
    assertNonEmptyString(args.agent_role, "agent_role");
  }
  // conversation_id — required non-empty string on the agent path.
  assertNonEmptyString(args.conversation_id, "conversation_id");
  // confirmation_token — required.
  assertNonEmptyString(args.confirmation_token, "confirmation_token");
}

// ---------------------------------------------------------------------------
// Substrate code → envelope code mapping
// ---------------------------------------------------------------------------

export function mapSubstrateCodeToEnvelope(substrateCode, rejectClass) {
  if (rejectClass === "token") return ERROR_CODES.PRIVILEGE_REQUIRED;
  if (rejectClass === "schema") return ERROR_CODES.INVALID_ARGUMENTS;
  if (substrateCode === "PARENT_NOT_FOUND" || substrateCode === "INVALID_PARENT_KIND") {
    return ERROR_CODES.NOT_FOUND;
  }
  if (substrateCode === "PARENT_EXCISED" || substrateCode === "PARENT_ORPHAN") {
    return ERROR_CODES.STATE_CONFLICT;
  }
  if (substrateCode === "INVALID_CTX") return ERROR_CODES.INTERNAL_ERROR;
  return ERROR_CODES.INTERNAL_ERROR;
}

// ---------------------------------------------------------------------------
// Audit-event helpers (handler step 6)
// ---------------------------------------------------------------------------

// Best-effort policy-events appender. Failures here don't abort the handler —
// the substrate has already done the durable work (or refused it). A stderr
// breadcrumb gives the operator visibility without crashing the caller.
function safeAppendPolicyEvent(event) {
  try {
    appendPolicyEvent(event);
  } catch (err) {
    console.error(
      `${NAME}: appendPolicyEvent failed (${event.kind}): ${err && err.message ? err.message : String(err)}`,
    );
  }
}

// Compute a deterministic nonce_hash surrogate for audit when the substrate
// has not surfaced one (e.g. early TOKEN_REQUIRED reject). We hash the token
// bytes themselves; the on-disk audit row carries a stable identifier without
// exposing the raw token.
function tokenNonceSurrogate(token) {
  if (typeof token !== "string" || token.length === 0) return null;
  return createHash("sha256").update(Buffer.from(token, "utf8")).digest("hex");
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handler(args) {
  // Step 2: payload validation. Throws ToolError(INVALID_ARGUMENTS) which
  // dispatch will marshal into the envelope.
  validatePayload(args);

  // Step 3: pre-compute the binding hash purely for audit visibility (the
  // substrate recomputes it independently inside verifyAgentToken; we don't
  // pass this value down). Hashing here is cheap and gives the audit row a
  // stable correlation key with the supervisor's mint event when one is
  // later wired through. canonicalJsonSha256Hex matches the substrate's
  // computeBindingObject byte-for-byte (sorted parent set; content hash over
  // raw UTF-8). Use a try/catch so a hash failure cannot crash the call.
  let bindingHashForAudit = null;
  try {
    const sortedParents = [...args.parents].sort();
    const bindingObject = {
      content_hash: createHash("sha256")
        .update(Buffer.from(args.content, "utf8"))
        .digest("hex"),
      parent_set_hash: canonicalJsonSha256Hex(sortedParents),
      conversation_id: args.conversation_id,
      scope: args.scope,
    };
    bindingHashForAudit = canonicalJsonSha256Hex(bindingObject);
  } catch {
    bindingHashForAudit = null;
  }

  // Step 4-5: delegate to the substrate. The substrate runs (in order):
  //   verifyAgentToken     — type/freshness/sig, binding, checkAndConsume
  //   assertParentsValid   — parents exist + not directly excised + not
  //                          transitively orphaned
  //   computeIdempotencyKey — agent-domain key per S4
  //   checkIdempotent      — replay returns prior memory_event_id
  //   extractFeatures      — entities, time_anchors, episodicity (defensive)
  //   appendLedgerRow      — fsync'd row + dir-fsync
  //
  // The agent_id is synthesized by the substrate from input.agent_role (when
  // present) or claude-code:<conversation_id> by default. The handler does
  // not override it — agent identity flows from the supervisor's mint
  // discipline (the token verification proves the operator approved THIS
  // agent for THIS call).
  const ledgerPath = memoryLedgerPath();
  let result;
  try {
    result = await emitReconstruction(
      {
        mode: "agent",
        token: args.confirmation_token,
        parents: args.parents,
        content: args.content,
        scope: args.scope,
        confidence: args.confidence,
        agent_role: args.agent_role,
        conversation_id: args.conversation_id,
      },
      { ledgerPath },
    );
  } catch (e) {
    // Defensive: the substrate is wrapped in try/catch at every internal
    // boundary, but a thrown error at the dynamic-import seam or in
    // appendLedgerRow's fsync calls is still possible. Surface as
    // INTERNAL_ERROR and DO NOT emit policy.token.consumed — the token may
    // not have been consumed, the supervisor will re-mint on retry.
    return errEnv(
      NAME,
      ERROR_CODES.INTERNAL_ERROR,
      `emitReconstruction threw: ${e && e.message ? e.message : String(e)}`,
    );
  }

  // Step 6: audit. The substrate result discriminates success / token-reject
  // / structural-reject; each gets a distinct audit shape.
  if (result.ok === true) {
    // Success — emit policy.token.consumed regardless of dedupe_action.
    // Replay (rejected_idempotent) still consumed a nonce on the way in;
    // the audit trail records both consumption events distinctly via the
    // nonce_hash field (each replay uses a fresh nonce).
    safeAppendPolicyEvent({
      kind: "policy.token.consumed",
      nonce_hash: bindingHashForAudit || tokenNonceSurrogate(args.confirmation_token),
      tool: NAME,
      accepted_at: serverTs(),
    });
    return ok(NAME, {
      memory_event_id: result.memory_event_id,
      dedupe_action: result.dedupe_action,
      dropped: false,
    });
  }

  // result.ok === false. Two cases: token-reject (substrate did not write,
  // nonce-store state depends on which step failed) vs structural-reject
  // (nonce IS consumed; the supervisor's mint did its job — the work
  // refused was the decision-not-to-promote).
  const substrateCode = result.code || "INTERNAL_ERROR";
  const envelopeCode = mapSubstrateCodeToEnvelope(substrateCode, result.reject_class);
  if (result.reject_class === "token") {
    // Token-side reject — the substrate refused before any ledger touch.
    // policy.token.rejected per the promote-fact precedent. nonce_hash is
    // null when the rejection fires before payload parse (matches
    // mcp-surface.md § Logging).
    safeAppendPolicyEvent({
      kind: "policy.token.rejected",
      nonce_hash_or_null: tokenNonceSurrogate(args.confirmation_token),
      reason: substrateCode,
      attempted_at: serverTs(),
    });
    return errEnv(
      NAME,
      envelopeCode,
      result.error || "daemon-signed token rejected",
      { reason: substrateCode },
    );
  }

  // Structural reject (PARENT_NOT_FOUND, PARENT_EXCISED, PARENT_ORPHAN,
  // INVALID_PARENT_KIND, schema-level codes that snuck past validatePayload,
  // or INTERNAL_ERROR). The nonce HAS been consumed (the substrate's
  // verifyAgentToken ran first and burned it). Emit policy.token.consumed
  // so the audit trail closes — same discipline as promote-fact's
  // CONSENT_BLOCKED path. The supervisor must mint a fresh token for any
  // retry; consent state may have changed and re-binding forces fresh
  // review.
  safeAppendPolicyEvent({
    kind: "policy.token.consumed",
    nonce_hash: bindingHashForAudit || tokenNonceSurrogate(args.confirmation_token),
    tool: NAME,
    accepted_at: serverTs(),
  });
  // Surface drop_reason/dropped on the data side so callers can branch on
  // "structurally rejected" without parsing error.code (matches the
  // F-NEW-W4-VERIFY-MEMORY-DISTILL-FALSE-OK pattern promote-fact uses for
  // salience-drops). The envelope is still {ok:false}; the dropped flag is
  // additive context inside .error.details for inspectability.
  return errEnv(
    NAME,
    envelopeCode,
    result.error || `emit refused: ${substrateCode}`,
    {
      reason: substrateCode,
      dropped: result.dropped === true,
      drop_reason: result.drop_reason || substrateCode,
    },
  );
}

// ---------------------------------------------------------------------------
// Tool export
// ---------------------------------------------------------------------------

export const TOOL = {
  name: NAME,
  description:
    "Distillation-only. Emit a reconstructed memory derived from existing parents (agent-driven summarization).",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: [
      "parents",
      "content",
      "scope",
      "conversation_id",
      "confirmation_token",
    ],
    properties: {
      parents: {
        type: "array",
        minItems: PARENTS_MIN,
        maxItems: PARENTS_MAX,
        items: { type: "string" },
      },
      content: {
        type: "string",
        minLength: RECONSTRUCT_CONTENT_MIN_CHARS,
        maxLength: CONTENT_MAX_CHARS,
      },
      scope: { type: "string", enum: [...EMIT_SCOPES] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      agent_role: { type: "string" },
      conversation_id: { type: "string" },
      confirmation_token: { type: "string" },
    },
  },
  handler,
};

// ---------------------------------------------------------------------------
// Inline 4-line self-test (only when invoked via `node distill-emit-reconstructed.js`)
// ---------------------------------------------------------------------------
const __isMain = (() => {
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (__isMain) {
  if (TOOL.name !== "memory_distill_emit_reconstructed") {
    throw new Error("name mismatch");
  }
  if (!TOOL.inputSchema.required.includes("confirmation_token")) {
    throw new Error("schema missing confirmation_token");
  }
  if (RECONSTRUCT_MIN_CONFIDENCE < 0 || RECONSTRUCT_MIN_CONFIDENCE > 1) {
    throw new Error("substrate confidence floor out of range");
  }
  console.error("distill-emit-reconstructed self-test ok");
}
