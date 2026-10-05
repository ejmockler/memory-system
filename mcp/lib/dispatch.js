// Routes tool calls to handlers. Catches ToolError and converts to envelope.
// Modeled on a sibling project's dispatch module.

import { ERROR_CODES, ToolError } from "./error-codes.js";
import { error as errEnv } from "./envelope.js";
import { withTelemetry } from "./telemetry.js";

import { TOOL as recall } from "./tools/recall.js";
import { TOOL as exclude } from "./tools/exclude.js";
import { TOOL as rescindPolicy } from "./tools/rescind-policy.js";
import { TOOL as get } from "./tools/get.js";
import { TOOL as getPredicate } from "./tools/get-predicate.js";
import { TOOL as listPredicates } from "./tools/list-predicates.js";
import { TOOL as health } from "./tools/health.js";
import { TOOL as connectorsList } from "./tools/connectors-list.js";
import { TOOL as connectorsRevoke } from "./tools/connectors-revoke.js";
import { TOOL as distillPromoteFact } from "./tools/distill-promote-fact.js";
import { TOOL as distillEmitReconstructed } from "./tools/distill-emit-reconstructed.js";
import { TOOL as put } from "./tools/put.js";
import { TOOL as catchup } from "./messaging/catchup.js";
import { TOOL as catchupFeedback } from "./messaging/feedback-log.js";

const REGISTRY = new Map();
for (const tool of [
  recall,
  exclude,
  rescindPolicy,
  get,
  getPredicate,
  listPredicates,
  health,
  connectorsList,
  connectorsRevoke,
  distillPromoteFact,
  distillEmitReconstructed,
  put,
  catchup,
  catchupFeedback,
]) {
  REGISTRY.set(tool.name, tool);
}

// Launch-identity gate (mcp-surface.md § Privilege levels — "SCOPE_BLOCKED via launch-identity").
// Read MEMORY_ROLE at module init; default "agent". The distillation supervisor spawns its
// child MCP with MEMORY_ROLE=distillation. Captured once at startup — env mutations after
// load do not affect dispatch, matching the per-subprocess launch-identity model.
const MEMORY_ROLE = process.env.MEMORY_ROLE || "agent";

// Phase 1 distillation tool: memory_distill_promote_fact.
// Phase 3 forward-declared: memory_distill_emit_policy, memory_distill_emit_reconstructed.
// Gating these now means a same-uid attacker who spawns a default-role server cannot reach
// the Phase 3 surfaces once they land — no later wiring required at the dispatch layer.
const DISTILLATION_ONLY_TOOLS = new Set([
  "memory_distill_promote_fact",
  "memory_distill_emit_policy",
  "memory_distill_emit_reconstructed",
]);

export function listTools() {
  return Array.from(REGISTRY.values()).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

export function toolCount() {
  return REGISTRY.size;
}

// L3 telemetry: the ONE seam every tool call flows through. withTelemetry
// emits exactly one bounded NDJSON line per call (fire-and-forget; a
// telemetry failure can never fail or slow the call) and passes the inner
// result through untouched — SCOPE_BLOCKED, NOT_FOUND, ToolError, unexpected
// throw, and success paths are all covered with zero per-tool changes.
export async function executeTool(name, args) {
  return withTelemetry(name, () => executeToolInner(name, args));
}

async function executeToolInner(name, args) {
  // Step 0: launch-identity scope check. Fires BEFORE payload parse, BEFORE token verification
  // (mcp-surface.md § Privilege levels). Distillation-only tools require MEMORY_ROLE=distillation
  // at the server's launch env. Args are untouched on this path — the gate is purely the tool
  // name and the captured role. NOT_FOUND still wins for unregistered names so probing for
  // tool existence remains independent of role; this matches the "scope before payload" ordering
  // the spec requires once the tool is real.
  if (DISTILLATION_ONLY_TOOLS.has(name) && MEMORY_ROLE !== "distillation") {
    return errEnv(
      name,
      ERROR_CODES.SCOPE_BLOCKED,
      "caller role is not distillation; this tool requires MEMORY_ROLE=distillation",
    );
  }
  const tool = REGISTRY.get(name);
  if (!tool) {
    return errEnv(name, ERROR_CODES.NOT_FOUND, `Unknown tool: ${name}`);
  }
  try {
    return await tool.handler(args || {});
  } catch (e) {
    if (e instanceof ToolError) {
      return errEnv(name, e.code, e.message, e.details);
    }
    return errEnv(name, ERROR_CODES.INTERNAL_ERROR, e.message || String(e));
  }
}
