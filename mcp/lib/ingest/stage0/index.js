// Stage-0 dispatcher.
//
// Layer 1 of the R25 salience cascade. Routes a source-row event to its
// per-source Stage-0 module based on event.source. Salience-core's Layer-1
// invokes stage0Dispatch only; per-source modules are an implementation
// detail.
//
// Returns: { decision: "DROP" | "REDACT_DROP" | "PASS",
//            reason: string | null,
//            structural_score?: number,
//            source?: string  // echoed for downstream policy events
//          }
//
// Unknown source values default to PASS with reason "unknown_source"; the
// salience core treats this as "let it through with default structural
// score" so we never silently lose rows from a new connector before its
// Stage-0 module ships.

import { stage0 as imessageStage0, structuralRules as imessageRules } from "./imessage.js";
import { stage0 as screentimeStage0, structuralRules as screentimeRules } from "./screentime.js";
import { stage0 as gitlogStage0, structuralRules as gitlogRules } from "./gitlog.js";
import { stage0 as githubeventsStage0, structuralRules as githubeventsRules } from "./githubevents.js";
// R28 Phase 2a — agent-runtime hook stage0 module. codex-cli is the sole
// agent-runtime hook source.
import { stage0 as codexCliStage0, structuralRules as codexCliRules } from "./codex-cli.js";
// F-T2-CHAT_CLAUDE-CODE-F6 / F7 — chat-claude-code agent-runtime hook stage0
// module. Mirrors codex-cli's shape; the connector at hooks/stop-hook.sh
// writes storage/sources/chat-claude-code.jsonl.
import {
  stage0 as chatClaudeCodeStage0,
  structuralRules as chatClaudeCodeRules,
} from "./chat-claude-code.js";
// R39 Phase 3b — WhatsApp connector stage0 module.
import { stage0 as whatsappStage0, structuralRules as whatsappRules } from "./whatsapp.js";
// R38 Phase 2c — Telegram source-tier stage0 module.
import { stage0 as telegramStage0, structuralRules as telegramRules } from "./telegram.js";
// R38 Phase 2c — Slack source-tier stage0 module.
import { stage0 as slackStage0, structuralRules as slackRules } from "./slack.js";
// R39 Phase 3a — Apple Mail Envelope Index + .emlx source-tier stage0 module.
import { stage0 as mailStage0, structuralRules as mailRules } from "./mail.js";
// F-INFRA-R40-TELEMETRY — per-reason drop telemetry. Every dispatch
// outcome (DROP, REDACT_DROP, PASS) increments a process-local counter
// keyed by {source, decision, reason}. The dispatcher wraps stage0Dispatch
// so per-source modules never have to know about the counter substrate.
import { recordDrop } from "./telemetry.js";

// F-CROSS-CROSS-SOURCE-DEDUP (R50) — generic Stage-1 cross-source dedup
// substrate. Re-exported here so per-source Stage-0 modules import the
// substrate from a single canonical place (mirroring how telemetry is
// fronted by this index). The dispatcher itself does NOT call
// checkCrossSourceDuplicate — invocation is opt-in per per-source module,
// which keeps each Stage-0 module's invariants visible at its own call
// site. Direct imports from ../cross-source-dedup.js stay supported; this
// re-export is the recommended path going forward.
export {
  checkCrossSourceDuplicate,
  CROSS_SOURCE_CONTRACTS,
  canonicalizeHandle,
  canonicalizeRepoBasename,
  withinWindow,
  lookupOtherSourceLedger,
} from "../cross-source-dedup.js";

const REGISTRY = Object.freeze({
  imessage: imessageStage0,
  screentime: screentimeStage0,
  "git-log": gitlogStage0,
  "github-events": githubeventsStage0,
  // R28 Phase 2a — sole agent-runtime hook source.
  "codex-cli": codexCliStage0,
  // F-T2-CHAT_CLAUDE-CODE-F6 / F7 — Claude Code agent-runtime hook source.
  // Wave-2 audit found 0 rows from this source had reached memory.jsonl
  // despite 765+ rows in storage/sources/chat-claude-code.jsonl because the
  // dispatcher REGISTRY had no entry and the watermark daemon skipped it via
  // a wildcard-only WATERMARK_SOURCES match. Registering here closes the
  // cascade gap.
  "chat-claude-code": chatClaudeCodeStage0,
  // R39 Phase 3b — WhatsApp Desktop ChatStorage.sqlite source.
  whatsapp: whatsappStage0,
  // R38 Phase 2c — Telegram source-tier connector.
  "telegram": telegramStage0,
  // R38 Phase 2c — Slack source-tier connector.
  "slack": slackStage0,
  // R39 Phase 3a — Apple Mail Envelope Index + .emlx source.
  mail: mailStage0,
});

const STRUCTURAL_RULES_REGISTRY = Object.freeze({
  imessage: imessageRules,
  screentime: screentimeRules,
  "git-log": gitlogRules,
  "github-events": githubeventsRules,
  // R28 Phase 2a — sole agent-runtime hook source.
  "codex-cli": codexCliRules,
  // F-T2-CHAT_CLAUDE-CODE-F6 / F7 — Claude Code agent-runtime hook source.
  "chat-claude-code": chatClaudeCodeRules,
  // R39 Phase 3b — WhatsApp Desktop ChatStorage.sqlite source.
  whatsapp: whatsappRules,
  // R38 Phase 2c — Telegram source-tier connector.
  "telegram": telegramRules,
  // R38 Phase 2c — Slack source-tier connector.
  "slack": slackRules,
  // R39 Phase 3a — Apple Mail Envelope Index + .emlx source.
  mail: mailRules,
});

export function stage0Dispatch(event) {
  if (!event || typeof event !== "object") {
    return { decision: "PASS", reason: null, source: null };
  }
  const source = typeof event.source === "string" ? event.source : null;
  const fn = source ? REGISTRY[source] : null;
  if (!fn) {
    // Unknown / unregistered source: PASS but flag the reason so the
    // salience scorer can route it through the default structural-score
    // fallback. Bare-missing source field (null) returns reason=null.
    const out = {
      decision: "PASS",
      reason: source ? "unknown_source" : null,
      source: source || null,
    };
    // F-INFRA-R40-TELEMETRY — count even the unknown_source path so the
    // operator can spot a new connector landing without its stage0 module.
    try {
      recordDrop(out.source, out.reason, out.decision);
    } catch {
      /* telemetry must never crash the hot path */
    }
    return out;
  }
  const result = fn(event);
  const out = { ...result, source };
  // F-INFRA-R40-TELEMETRY — every dispatch outcome (DROP, REDACT_DROP,
  // PASS) increments the counter. recordDrop canonicalises null/empty
  // reasons to "pass" so PASS volume is observable as the denominator
  // for any drop-rate calculation.
  //
  // F-NEW-W7-STAGE0-COUNTERS-FIELDS — explicit triple-of-non-null guard.
  // The earlier W4 check-in surfaced (separate from W7) a hypothesis
  // that source/decision/reason might be passed through as undefined.
  // The actual recordDrop call below uses `source` (closure variable
  // captured from line 111, where it is `typeof event.source === "string"
  // ? event.source : null`) NOT `out.source` (which is the same value
  // shallow-spread in {...result, source}), and `out.reason` /
  // `out.decision` come from the per-source module return shape. Per-
  // source modules are required to return both fields; the explicit
  // pre-extract here documents the invariant and makes a future review
  // of "why did the counter row carry null fields" trivially mappable
  // back to which of the three fields the per-source module forgot.
  const recDecision = out.decision; // required by per-source contract
  const recReason = out.reason; // null only for synthetic PASS path
  try {
    recordDrop(source, recReason, recDecision);
  } catch {
    /* telemetry must never crash the hot path */
  }
  return out;
}

// R25.6 CRIT-A — caller-agnostic dispatch alias.
//
// Two production call sites use mismatched lookup names + signatures:
//   - daemons/watermark.js:957  mods.stage0.dispatch(source, event, opts)
//   - mcp/lib/ingest/salience.js:427  dispatch(event.source, event)
//
// The declared name is stage0Dispatch, so both sites silently fall through
// (typeof === "function" / != null guard returns falsy) and Stage-0 is
// skipped entirely in production. That's the R25.5 bug-class (CRIT-A) and the
// second iteration of the export-vs-lookup family.
//
// Fix: export an alias named `dispatch` that accepts either calling
// convention.
//   - 1-arg form (event)  -> production stage0Dispatch directly
//   - 2/3-arg form (source, event[, opts]) -> stamp event.source from
//     arg0 if missing/different (caller is authoritative), drop opts (the
//     dispatcher is pure and doesn't need {now}).
//
// Also exported as default so `mod.default` lookups resolve, matching the
// convention salience.js:183 falls back to.
export function dispatch(sourceOrEvent, eventMaybe, _opts) {
  // 1-arg form: arg0 is the event.
  if (eventMaybe === undefined) {
    return stage0Dispatch(sourceOrEvent);
  }
  // 2/3-arg form: arg0 is the source string, arg1 is the event.
  if (eventMaybe == null || typeof eventMaybe !== "object") {
    return { decision: "PASS", reason: null, source: null };
  }
  // Caller's source is authoritative; stamp it onto the event if the event
  // lacks one, so the registry routes correctly.
  const event =
    typeof sourceOrEvent === "string" &&
    sourceOrEvent.length > 0 &&
    typeof eventMaybe.source !== "string"
      ? { ...eventMaybe, source: sourceOrEvent }
      : eventMaybe;
  return stage0Dispatch(event);
}

export default dispatch;

// Exported for tests + operator tooling.
export function listSources() {
  return Object.keys(REGISTRY);
}

export function getStructuralRules(source) {
  const fn = STRUCTURAL_RULES_REGISTRY[source];
  return fn ? fn() : {};
}
