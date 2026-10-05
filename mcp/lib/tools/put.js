/** memory_put — operator-authored direct memory write. WORKUNIT N8.
 *
 * The ONLY first-class surface for an operator to deliberately record a fact
 * they KNOW (e.g. "my mother's birthday is March 3") without fabricating a
 * source-ledger row + minting a daemon token. Unlike memory_distill_promote_fact
 * (dispatch-gated to MEMORY_ROLE=distillation, daemon-token + nonce + binding +
 * consent-walk), memory_put:
 *   - needs NO confirmation_token (the operator IS the trust root),
 *   - runs NO source-ledger consent walk (operator asserts their OWN basis),
 *   - stamps consent_basis="first_party" on every source ref,
 *   - is DARK BY DEFAULT on a configured install (CAPS.MEMORY_PUT_ENABLED /
 *     env MEMORY_PUT_ENABLED). The one unconfigured exception is a standalone
 *     first run with no vector index — see putEnabled() below.
 *
 * It routes through the SAME appendFactRow chokepoint (via appendOperatorFact)
 * so the operator fact inherits the FULL synthesis stamp cascade with zero
 * re-implementation: features.entities, features.entity_extractor_version,
 * gazetteer adds, row-parties, features.time_anchors[0]={...stamped_by:
 * "cascade:row-ts"}, features.valence, features.episodicity ∈ [0,1],
 * features.thread_keys — plus the ledger durability discipline (file-fsync +
 * dir-fsync + per-row checksum + O_APPEND append-only write).
 *
 * Thesis #1: only APPENDS a new fact row + emits one policy.memory.put audit
 * event. NEVER mutates an existing fact row.
 */

import { ok, serverTs } from "../envelope.js";
import { ERROR_CODES, ToolError } from "../error-codes.js";
import {
  CAPS,
  assertObjectShape,
  assertNonEmptyString,
  assertObject,
  assertEnum,
  assertOptionalStringArray,
} from "../validation.js";
import {
  appendOperatorFact,
  standaloneLexicalFirstRun,
} from "./distill-promote-fact.js";
import { appendPolicyEvent } from "../policy-events.js";

const NAME = "memory_put";

// Operator confidence enum: the daemon-only "pre_distilled" level is excluded
// (M1) — an operator-authored fact is first-party, not a pre-distillation
// inference. Default "high" when omitted.
const OPERATOR_CONFIDENCE_ENUM = ["high", "medium", "low"];

// Gate read (tri-state, evaluated at call time). CAPS.MEMORY_PUT_ENABLED stays
// the frozen default (false); the env var is the operator's explicit choice:
//   MEMORY_PUT_ENABLED=1 | true   -> on  (unchanged override)
//   MEMORY_PUT_ENABLED=0 | false  -> off (explicit opt-out; wins over CAPS and
//                                    over the first-run rule below)
//   CAPS.MEMORY_PUT_ENABLED true  -> on
//   unset (or any other value)    -> on ONLY for a standalone first run with no
//                                    vector index (standaloneLexicalFirstRun():
//                                    this process is not a queryd client AND the
//                                    on-disk index tree for the active model
//                                    holds no vector index and is intact);
//                                    otherwise off. A refused, truncated or
//                                    unreadable index is NOT a first run.
//
// Why the default is not simply "on": the gate exists because memory_put lets
// an agent-role caller write first_party facts with no daemon token (see the
// header above and the CAPS.MEMORY_PUT_ENABLED comment in validation.js). That
// write authority stays dark on every configured install — queryd serving, or
// any vector in the active index, i.e. a root that holds a connector-ingested
// corpus. The decision is read from the on-disk artefacts and fails closed: a
// manifest that cannot be read, a member whose size disagrees with its record,
// a refused generation or any stat/read error keeps the put dark. A standalone
// root with no vector index (none on disk, or only the empty-HNSW generation
// the install itself published) has no such corpus to contaminate, and without
// this rule a fresh checkout could write nothing.
// Once the first vector lands the rule stops applying and the operator opts in
// with MEMORY_PUT_ENABLED=1.
async function putEnabled() {
  const env = process.env.MEMORY_PUT_ENABLED;
  if (env === "1" || env === "true") return true;
  if (env === "0" || env === "false") return false;
  if (CAPS.MEMORY_PUT_ENABLED === true) return true;
  return standaloneLexicalFirstRun();
}

function validatePayload(args) {
  // additionalProperties:false analogue — reject unknown top-level keys.
  assertObjectShape(args, "args", [
    "content",
    "provenance",
    "source_refs",
    "derived_from",
  ]);

  assertNonEmptyString(args.content, "content", {
    maxChars: CAPS.CONTENT_MAX_CHARS,
  });

  const prov = assertObject(args.provenance, "provenance");
  // confidence is optional (defaults to "high"); when present it must be a
  // valid operator confidence level.
  if (prov.confidence !== undefined && prov.confidence !== null) {
    assertEnum(prov.confidence, OPERATOR_CONFIDENCE_ENUM, "provenance.confidence");
  }
  if (prov.agent_id !== undefined && prov.agent_id !== null) {
    if (typeof prov.agent_id !== "string") {
      throw new ToolError(
        ERROR_CODES.INVALID_ARGUMENTS,
        "provenance.agent_id must be a string",
      );
    }
  }
  if (prov.conversation_id !== undefined && prov.conversation_id !== null) {
    if (typeof prov.conversation_id !== "string") {
      throw new ToolError(
        ERROR_CODES.INVALID_ARGUMENTS,
        "provenance.conversation_id must be a string",
      );
    }
  }

  // source_refs is optional. When present each entry must carry a non-empty
  // source string; source_msg_id is optional (minted if absent). consent_basis
  // is intentionally NOT honored here — appendOperatorFact forces first_party.
  if (args.source_refs !== undefined && args.source_refs !== null) {
    if (!Array.isArray(args.source_refs)) {
      throw new ToolError(
        ERROR_CODES.INVALID_ARGUMENTS,
        "source_refs must be an array",
      );
    }
    for (let i = 0; i < args.source_refs.length; i++) {
      const r = args.source_refs[i];
      if (r == null || typeof r !== "object" || Array.isArray(r)) {
        throw new ToolError(
          ERROR_CODES.INVALID_ARGUMENTS,
          `source_refs[${i}] must be an object`,
        );
      }
      assertNonEmptyString(r.source, `source_refs[${i}].source`);
      if (r.source_msg_id !== undefined && r.source_msg_id !== null) {
        if (typeof r.source_msg_id !== "string") {
          throw new ToolError(
            ERROR_CODES.INVALID_ARGUMENTS,
            `source_refs[${i}].source_msg_id must be a string`,
          );
        }
      }
    }
  }

  // derived_from is an optional array of memory_event_id strings.
  assertOptionalStringArray(args.derived_from, "derived_from");
}

async function handler(args) {
  // Step 0: the put gate (see putEnabled). Fires BEFORE the payload is parsed,
  // BEFORE any ledger write — so a blocked put leaves the ledger AND
  // policy-events byte-unchanged (R2). SCOPE_BLOCKED mirrors the dispatch-layer
  // distillation-only gate's error code.
  if (!(await putEnabled())) {
    throw new ToolError(
      ERROR_CODES.SCOPE_BLOCKED,
      "memory_put is disabled: it is on by default only for a standalone first run with no vector index; set env MEMORY_PUT_ENABLED=1 to enable operator-authored memory writes (MEMORY_PUT_ENABLED=0 forces it off)",
    );
  }

  // Step 1: payload validation.
  validatePayload(args);

  // Step 2: route through the appendFactRow chokepoint (operator-stamped). The
  // synthesis cascade fires inside appendFactRow — we do NOT re-implement it.
  // v0 omits inline embed: the row lands embeddingless and nothing re-embeds it
  // automatically (appendOperatorFact writes no sweep entry). On a standalone
  // first run with no vector index it is added to the active BM25 at write time
  // and recall serves it lexically, marked degraded; on a configured install it
  // is lexically indexed only under MEMORY_BM25_DECOUPLE_EMBED. An embedder
  // outage MUST NOT block the put.
  let result;
  try {
    result = await appendOperatorFact({
      content: args.content,
      provenance: args.provenance,
      source_refs: args.source_refs,
      derived_from: args.derived_from,
    });
  } catch (e) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `memory_put: ledger append failed: ${e && e.message ? e.message : String(e)}`,
    );
  }

  // Step 3: audit event. Emitted AFTER the fact row is durably fsync'd. A
  // policy-events failure here does NOT roll back the fact row (data capture >
  // audit completeness, mirroring the promote path's H3 ordering); we log a
  // breadcrumb and still return ok with the minted id.
  try {
    appendPolicyEvent({
      kind: "policy.memory.put",
      tool: NAME,
      memory_event_id: result.memory_event_id,
      promoted_at: result.promoted_at,
      consent_basis: "first_party",
    });
  } catch (e) {
    console.error(
      `memory_put: policy.memory.put audit emit failed for ${result.memory_event_id} (row is durable): ${e && e.message ? e.message : String(e)}`,
    );
  }

  return ok(NAME, {
    memory_event_id: result.memory_event_id,
    promoted_at: result.promoted_at,
  });
}

export const TOOL = {
  name: NAME,
  description:
    "Record a user-authored memory directly. First-party write: the user asserts the fact (consent_basis=first_party), no daemon token required. The fact inherits the full synthesis stamp cascade (entities, time anchors, valence, episodicity) and is returned by memory_recall by default only on a standalone first run with no vector index; on a configured install the row is written without an inline vector and is recalled only when the server also runs with MEMORY_BM25_DECOUPLE_EMBED=1. On by default only for a standalone first run with no vector index; otherwise dark unless MEMORY_PUT_ENABLED=1 (MEMORY_PUT_ENABLED=0 forces it off). Use when the user KNOWS a fact and wants it remembered without a source connector.",
  inputSchema: {
    type: "object",
    required: ["content", "provenance"],
    additionalProperties: false,
    properties: {
      content: { type: "string", maxLength: CAPS.CONTENT_MAX_CHARS },
      provenance: {
        type: "object",
        additionalProperties: false,
        properties: {
          agent_id: { type: "string" },
          conversation_id: { type: "string" },
          confidence: { type: "string", enum: OPERATOR_CONFIDENCE_ENUM },
        },
      },
      source_refs: {
        type: "array",
        items: {
          type: "object",
          required: ["source"],
          additionalProperties: false,
          properties: {
            source: { type: "string" },
            source_msg_id: { type: "string" },
          },
        },
      },
      derived_from: {
        type: "array",
        items: { type: "string" },
      },
    },
  },
  handler,
};

// Re-exported for the put test's gate-default assertion + serverTs symmetry with
// the other tool modules (no behavioral coupling).
export { serverTs };
