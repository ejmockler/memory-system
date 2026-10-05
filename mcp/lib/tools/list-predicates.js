/** memory_list_predicates — see kb/mcp-surface.md § memory_list_predicates. */

import { ok } from "../envelope.js";
import {
  CAPS,
  assertObjectShape,
  assertOptionalIntInRange,
  assertOptionalString,
  assertOptionalStringArray,
} from "../validation.js";
import { activePredicates } from "./exclude.js";

const NAME = "memory_list_predicates";

function scopeMatchesFilter(predicateScope, filter) {
  if (filter == null) return true;
  if (predicateScope === "global") {
    // Global predicates pass any filter that does not constrain them further
    // than a scope filter could express. For Phase 0 a scoped filter never
    // matches a global predicate (global is its own bucket).
    return filter.agent_role == null && (filter.parties == null || filter.parties.length === 0);
  }
  if (typeof predicateScope !== "object" || predicateScope === null) return false;
  if (filter.agent_role != null && predicateScope.agent_role !== filter.agent_role) return false;
  if (filter.parties != null) {
    if (!Array.isArray(predicateScope.parties)) return false;
    for (const p of filter.parties) {
      if (!predicateScope.parties.includes(p)) return false;
    }
  }
  return true;
}

async function handler(args) {
  assertObjectShape(args, "args", ["scope_filter", "max_items"]);

  if (args.scope_filter != null) {
    assertObjectShape(args.scope_filter, "scope_filter", ["agent_role", "parties"]);
    assertOptionalString(args.scope_filter.agent_role, "scope_filter.agent_role");
    assertOptionalStringArray(args.scope_filter.parties, "scope_filter.parties");
  }
  const maxItems = assertOptionalIntInRange(args.max_items, "max_items", {
    min: 1,
    max: CAPS.LIST_PREDICATES_MAX_ITEMS,
  });

  // Project the live activePredicates map into the spec output shape.
  // Source of truth lives in exclude.js (not in this tool) — list_predicates
  // is a read-only view. Two-pass: count + collect filter-matching, then cap.
  const cap = maxItems ?? CAPS.LIST_PREDICATES_MAX_ITEMS;
  const matching = [];
  let totalActive = 0;
  for (const entry of activePredicates.values()) {
    if (!entry.active) continue;
    totalActive += 1;
    if (!scopeMatchesFilter(entry.scope, args.scope_filter)) continue;
    matching.push({
      predicate_id: entry.predicate_id,
      captured_at: entry.captured_at,
      context_entities: entry.context_entities,
      scope: entry.scope,
      active: entry.active,
    });
  }
  const projected = matching.slice(0, cap);
  const truncated = matching.length > projected.length;

  return ok(NAME, {
    predicates: projected,
    total_active: totalActive,
    truncated,
  });
}

export const TOOL = {
  name: NAME,
  description: "List active exclude predicates. For debugging; not the daily path.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      scope_filter: {
        type: "object",
        additionalProperties: false,
        properties: {
          agent_role: { type: "string" },
          parties: { type: "array", items: { type: "string" } },
        },
      },
      max_items: {
        type: "integer",
        minimum: 1,
        maximum: CAPS.LIST_PREDICATES_MAX_ITEMS,
      },
    },
  },
  handler,
};
