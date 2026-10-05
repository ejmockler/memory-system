// conversation-stamp.js — WU-forward-conversation-stamp (forward-only).
//
// PURPOSE:
//   At promote time, derive a canonical CONVERSATION/THREAD descriptor for a
//   fact from its in-scope source-ledger row and return it in the exact shape
//   the read path (recall/context-prefix.js readConversationId +
//   deriveThreadLabel) already parses:
//
//       "daemon:thread:<bucket_key>"
//
//   where <bucket_key> is produced by the SAME extractThreadKey logic the
//   thread-aggregator uses (synthesis/thread-aggregator.js __internal). Reusing
//   that one function is load-bearing: a reconstructed event emitted by the
//   daemon aggregator and an atomic fact promoted from the same source row MUST
//   collide on a byte-identical thread descriptor so context-prefix degrades
//   gracefully and recall groups them.
//
// WHY HERE (ground truth, investigated against the live repo):
//   - provenance.conversation_id was hardcoded `null` at BOTH promote callers
//     (the watermark promoteSourceRow args literal and the MCP handler's
//     supervisor-supplied provenance). appendFactRow copies it verbatim, so
//     ~0% of promoted fact rows carried a thread key. This module supplies the
//     real value so the existing read path lights up with ZERO read-side change.
//   - extractThreadKey reads raw_content fields (chat_guid/session_jid/repo_path
//     /conversation_id...) that survive on the source-ledger row but NOT on the
//     promoted fact row. Both callers have the source row in scope at stamp time
//     (watermark: `event`; MCP: `firstSourceRow`), so we derive there.
//
// THESIS #1 (NEVER mutate existing fact rows): this is forward-only. It only
//   shapes the provenance the callers pass to appendFactRow for NEW rows; it
//   never reads or rewrites any existing ledger row. The backward direction is
//   a separate, optional sidecar projection (out of scope for this WU).
//
// CONTRACT:
//   deriveConversationId(sourceRow) -> string | null
//     - Pure. Deterministic (bucket_key is deterministic -> re-promotes stable).
//     - Defensive: a missing / malformed source row, a source with no derivable
//       thread key, or a throw inside extractThreadKey ALL return null. Never
//       throws. A null return means "omit the field" — the caller leaves
//       provenance.conversation_id = null, exactly as before.
//
// CAPS-gate: none required. There is no per-call cap to allocate (the descriptor
//   is a single derived string), and the field already exists in the row schema
//   (provenance.conversation_id) and is already read by recall — so this is a
//   pure population of an existing, already-honored field.

import { __internal as threadAggregatorInternal } from "./thread-aggregator.js";

const { extractThreadKey } = threadAggregatorInternal;

// The exact marker the read path strips (context-prefix.js deriveThreadLabel
// line ~173: `id.startsWith("daemon:thread:")`). Centralized so the forward
// stamp and the read path can never drift on the prefix string.
export const THREAD_DESCRIPTOR_PREFIX = "daemon:thread:";

// ---------------------------------------------------------------------------
// deriveConversationId — build "daemon:thread:<bucket_key>" from a source row.
//
// `sourceRow` is the raw source-ledger row (NOT a fact row): it carries
//   { source, ts, source_msg_id, raw_content: {...}, parties, ... }
// extractThreadKey wants a fact-SHAPED object reading `source`, `ts`, and
// raw_content (via raw_content sibling OR source_refs[0].raw_content OR
// features.raw_content). We hand it a synthetic shape that exposes the source
// row's raw_content on all three readers, so whichever the aggregator probes
// first it sees the same data — guaranteeing the forward stamp's bucket_key is
// byte-identical to the daemon reconstruction path's bucket_key.
// ---------------------------------------------------------------------------
export function deriveConversationId(sourceRow) {
  try {
    if (sourceRow == null || typeof sourceRow !== "object") return null;

    const source =
      typeof sourceRow.source === "string" && sourceRow.source.length > 0
        ? sourceRow.source
        : null;
    if (source === null) return null;

    // ts feeds extractThreadKey's day bucket. Source rows carry an ISO `ts`.
    const ts = typeof sourceRow.ts === "string" ? sourceRow.ts : null;

    const rawContent =
      sourceRow.raw_content && typeof sourceRow.raw_content === "object"
        ? sourceRow.raw_content
        : null;

    const sourceMsgId =
      typeof sourceRow.source_msg_id === "string"
        ? sourceRow.source_msg_id
        : null;

    // Synthetic fact-shaped object. We populate raw_content on the sibling
    // field, inside source_refs[0], AND under features.raw_content so all three
    // of extractThreadKey/readRawContent's probes resolve to the same object.
    const synthetic = {
      source,
      ts,
      raw_content: rawContent,
      source_refs:
        rawContent || sourceMsgId
          ? [
              {
                source,
                source_msg_id: sourceMsgId,
                raw_content: rawContent,
              },
            ]
          : [],
      features: rawContent ? { raw_content: rawContent } : {},
      // Carry through any pre-existing conversation_id so the generic fallback
      // branch (codex-cli / chat-claude-code thread on raw_content.conversation_id,
      // git/imessage/whatsapp on their structured keys) still works if a source
      // row only carried it under provenance.
      provenance:
        sourceRow.provenance && typeof sourceRow.provenance === "object"
          ? sourceRow.provenance
          : {},
    };

    const key = extractThreadKey(synthetic);
    if (
      key == null ||
      typeof key !== "object" ||
      typeof key.bucket_key !== "string" ||
      key.bucket_key.length === 0
    ) {
      return null;
    }
    return `${THREAD_DESCRIPTOR_PREFIX}${key.bucket_key}`;
  } catch {
    // Defensive: any throw (malformed row, aggregator bug) degrades to "omit".
    return null;
  }
}
