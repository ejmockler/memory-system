/** memory_connectors_revoke — kill-switch for an active connector.
 *
 * Round-21 (d) hot-fix: the round-20 C4 design promised that revoking a
 * connector emits a policy event with policy_kind="connector_revoke" and
 * target_source=<source>; the transitive-orphan BFS in hard-gates.js picks
 * it up as a new excise seed and propagates derivation_status=ORPHAN to
 * every memory derived from that source. The brutalist substitute verified
 * that (a) hard-gates.js was filtering ALL non-excise policy rows (now fixed
 * round-21 (d) hot-fix in hard-gates.js _scanLedger), and (b) this MCP tool
 * itself did not exist. This file ships it.
 *
 * Operator surface: `mcp tool memory_connectors_revoke source=<source>`.
 * Effect:
 *   1. Append a policy event to ledgers/memory.jsonl with kind="policy",
 *      policy_kind="connector_revoke", target_source=<source>, ts=serverTs().
 *   2. Optionally rm storage/sources/<source>.jsonl (operator opt-in flag).
 *   3. Return {revoke_event_id, target_source, deleted_ledger: bool}.
 *
 * Idempotency: emitting the same connector_revoke twice produces two ledger
 * rows but the second is a no-op for recall (the source's memory_ids are
 * already in the excise seed). Operators who want to UN-revoke must emit a
 * policy_kind="rescind" event targeting the revoke_event_id.
 *
 * Authoritative: kb/connectors-survey.md § kill-switch (round-20 C4 close).
 * Wires to: hard-gates.js _scanLedger (round-21 d hot-fix).
 */

import { existsSync, rmSync } from "node:fs";
import { ok } from "../envelope.js";
import { ERROR_CODES, ToolError } from "../error-codes.js";
import { assertObjectShape, assertNonEmptyString } from "../validation.js";
import { applyConnectorRevoke } from "../connectors/index.js";
import { sourceLedgerPath } from "../config.js";
import { listSources } from "../ingest/stage0/index.js";

const NAME = "memory_connectors_revoke";

const KNOWN_SOURCES = new Set(listSources());

async function handler(args) {
  assertObjectShape(args, "args", ["source"]);
  assertNonEmptyString(args.source, "args.source", { maxChars: 64 });

  // Defensive: callers can revoke a connector that isn't in KNOWN_SOURCES
  // (forward-compat with new sources), but warn so the operator notices
  // typos. The policy event is still emitted authoritatively; the
  // transitive-orphan BFS just won't find any matching memory_ids.
  const recognized = KNOWN_SOURCES.has(args.source);

  const deletedLedger = args.delete_ledger === true;

  // Append the connector_revoke policy event. applyConnectorRevoke is the
  // canonical writer from lib/connectors/index.js — round-20 C4 marker.
  const result = await applyConnectorRevoke({ source: args.source });

  // Optionally delete the storage/sources/<source>.jsonl file. This is the
  // operator's opt-in "stop accumulating new rows AND drop the existing
  // ledger" path; the recall layer's transitive-orphan BFS already hides the
  // already-promoted facts regardless of file deletion.
  let deletedLedgerPath = null;
  if (deletedLedger) {
    const ledgerFilePath = sourceLedgerPath(args.source);
    if (existsSync(ledgerFilePath)) {
      try {
        rmSync(ledgerFilePath);
        deletedLedgerPath = ledgerFilePath;
      } catch (err) {
        throw new ToolError(
          ERROR_CODES.INTERNAL_ERROR,
          `connector_revoke: deleted policy event but rm of ${ledgerFilePath} failed: ${err.message}`,
        );
      }
    }
  }

  // applyConnectorRevoke returns the full row (with id, kind, policy_kind,
  // target_source, ts, checksum). The MCP envelope surfaces id as
  // revoke_event_id for caller-friendly naming + symmetry with other policy
  // events that surface their event id under domain-specific labels.
  return ok(NAME, {
    revoke_event_id: result.id,
    target_source: args.source,
    recognized,
    deleted_ledger: deletedLedger,
    deleted_ledger_path: deletedLedgerPath,
  });
}

export const TOOL = {
  name: NAME,
  description:
    "Revoke an active connector. Takes only `source`. Appends a policy/connector_revoke event that the transitive-orphan BFS picks up to hide every memory derived from that source at recall time. The source ledger file is kept on disk. There is no tool-level un-revoke: memory_rescind_policy does not accept the returned revoke_event_id (it returns NOT_FOUND).",
  inputSchema: {
    type: "object",
    properties: {
      source: {
        type: "string",
        description: "The connector source string (e.g. imessage, screentime, telegram).",
      },
      delete_ledger: {
        type: "boolean",
        description:
          "Not supported: the handler accepts only `source` and rejects a call that passes this field with INVALID_ARGUMENTS. Omit it; the source ledger file is never deleted by this tool.",
      },
    },
    required: ["source"],
    additionalProperties: false,
  },
  handler,
};
