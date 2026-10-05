/** memory_rescind_policy — see kb/mcp-surface.md § memory_rescind_policy. */

import { ok, serverTs } from "../envelope.js";
import { ERROR_CODES, ToolError } from "../error-codes.js";
import {
  CAPS,
  assertNonEmptyString,
  assertObjectShape,
  assertOptionalString,
} from "../validation.js";
import { activePredicates, appendPredicateRow } from "./exclude.js";

const NAME = "memory_rescind_policy";

function countActive() {
  let n = 0;
  for (const p of activePredicates.values()) {
    if (p.active) n += 1;
  }
  return n;
}

async function handler(args) {
  assertObjectShape(args, "args", [
    "policy_event_id",
    "conversation_id",
    "agent_role",
    "rationale",
  ]);

  const policyEventId = assertNonEmptyString(args.policy_event_id, "policy_event_id");
  assertNonEmptyString(args.conversation_id, "conversation_id");
  assertNonEmptyString(args.agent_role, "agent_role");
  assertOptionalString(args.rationale, "rationale", { maxChars: CAPS.RATIONALE_CHARS });

  // Server-side ledger lookup: the active-predicates registry is the live
  // source of truth. Phase 0 only emits exclude policies, so any missing id
  // is genuinely unknown (no replace/substitute store yet).
  const entry = activePredicates.get(policyEventId);
  if (!entry) {
    throw new ToolError(
      ERROR_CODES.NOT_FOUND,
      `policy_event_id not found: ${policyEventId}`,
    );
  }

  // Phase 0: only exclude policies exist in the registry. Phase 3 extends
  // the registry to carry replace/substitute kinds and the resolution
  // happens on the entry's policy_kind field; default kept for safety.
  const policyKind = typeof entry.policy_kind === "string" ? entry.policy_kind : "exclude";

  // Idempotent: was_active reflects entry.active at the moment of the call.
  // First rescind flips it; subsequent rescinds observe false.
  const wasActive = entry.active === true;
  if (wasActive) {
    const rescindedAt = serverTs();
    // B1a2b: persist the tombstone BEFORE the in-memory flip. The recall gate
    // (loadActivePredicates in mcp/lib/recall/hard-gates.js) reads
    // predicates.jsonl fresh per recall and collapses by predicate_id
    // last-write-wins, so this append is what actually stops the predicate
    // from masking — the Map flip alone would return success while the disk
    // row kept gating (and resurrected after restart). Same loud-failure
    // stance as the emit path in exclude.js: persist failure throws
    // INTERNAL_ERROR and the registry stays untouched, so we never report a
    // rescind that is not durably enforced.
    try {
      appendPredicateRow({
        policy_kind: policyKind,
        predicate_id: policyEventId,
        active: false,
        rescinded_at: rescindedAt,
        emitted_by: {
          conversation_id: args.conversation_id,
          agent_role: args.agent_role,
        },
      });
    } catch (err) {
      throw new ToolError(
        ERROR_CODES.INTERNAL_ERROR,
        `failed to persist rescind tombstone to predicates.jsonl: ${err.message}`,
      );
    }
    entry.active = false;
    entry.rescinded_at = rescindedAt;
  }

  const data = {
    policy_event_id: policyEventId,
    policy_kind: policyKind,
    rescinded_at: entry.rescinded_at ?? serverTs(),
    was_active: wasActive,
  };

  // active_predicates_count is exclude-kind only; omit for the other kinds.
  if (policyKind === "exclude") {
    data.active_predicates_count = countActive();
  }

  return ok(NAME, data);
}

export const TOOL = {
  name: NAME,
  description:
    "Deactivate an active forgetting-policy event (exclude predicate, replace, or substitute). Append-only: the policy event stays in the ledger marked rescinded; recall no longer applies it. The single inverse for every apply-only forgetting verb.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["policy_event_id", "conversation_id", "agent_role"],
    properties: {
      policy_event_id: { type: "string" },
      conversation_id: { type: "string" },
      agent_role: { type: "string" },
      rationale: { type: "string", maxLength: CAPS.RATIONALE_CHARS },
    },
  },
  handler,
};
