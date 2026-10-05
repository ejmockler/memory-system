/** memory_get_predicate — see kb/mcp-surface.md § memory_get_predicate. */

import { ok } from "../envelope.js";
import { ERROR_CODES, ToolError } from "../error-codes.js";
import { assertNonEmptyString, assertObjectShape } from "../validation.js";
import { activePredicates } from "./exclude.js";

const NAME = "memory_get_predicate";

async function handler(args) {
  assertObjectShape(args, "args", ["predicate_id"]);
  const predicateId = assertNonEmptyString(args.predicate_id, "predicate_id");

  const captured = activePredicates.get(predicateId);
  if (!captured) {
    throw new ToolError(ERROR_CODES.NOT_FOUND, `predicate_id "${predicateId}" not found`);
  }

  // Surface the model_version actually captured on emit (from the recall
  // log entry the predicate was bound to), not a global constant. This is
  // what makes the propose-back UX honest: the agent shows the user what
  // *this* predicate's binding promises, not a server default.
  const embeddingModelVersion =
    captured.embedding_snapshot?.embedding_model_version ?? "stub-0.0.1";

  return ok(NAME, {
    predicate_id: captured.predicate_id,
    captured_at: captured.captured_at,
    emitted_by: captured.emitted_by,
    context_entities: captured.context_entities,
    similarity_threshold: captured.similarity_threshold,
    scope: captured.scope,
    rationale: captured.rationale,
    embedding_model_version: embeddingModelVersion,
    // Mock embedding summary — the human-readable proxy for the otherwise-opaque
    // vector. Empty in Phase 0; populated when recall snapshots an embedding.
    embedding_summary: {
      nearest_entities: [],
      nearest_memories: [],
    },
    active: captured.active,
  });
}

export const TOOL = {
  name: NAME,
  description:
    "Read a captured exclude predicate by id. Use this to surface an interpretation back to the user for confirmation before a write.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["predicate_id"],
    properties: {
      predicate_id: { type: "string" },
    },
  },
  handler,
};
