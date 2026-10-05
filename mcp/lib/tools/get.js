/** memory_get — see kb/mcp-surface.md § memory_get. */
//
// Ledger-backed read-by-id (F1, 2026-09-14). Replaces the Phase-0 stub that
// fabricated a canned row for every id. The row is resolved through the
// offset index (`seekLedgerRowsByIds`: positioned reads in 64 KiB windows,
// each hit id-verified) and projected into the kb/mcp-surface.md § memory_get
// shape. Read-only over the ledger: this tool never streams or slurps the
// 3.67 GB file whole, never writes it, and applies no exclude predicate or
// hard-gates masking (kb/mcp-surface.md:822 — "respects nothing beyond ledger
// integrity"). The only disk writes on this path are the pre-existing
// fire-and-forget sidecar rewrites (memory.jsonl.offsets,
// derivation-graph.cache.json) that memory_recall already performs.

import { join } from "node:path";
import { ok } from "../envelope.js";
import { ERROR_CODES, ToolError } from "../error-codes.js";
import { assertNonEmptyString, assertObjectShape } from "../validation.js";
import { STORAGE_DIR, memoryLedgerPath } from "../config.js";
import { seekLedgerRowsByIds } from "../recall/ledger-offset-index.js";
import { __resolveProvenanceAttribution } from "./recall.js";
import { loadOrRebuildDerivationGraph } from "../synthesis/derivation-graph.js";

const NAME = "memory_get";

// A numeric array longer than this is treated as an embedding vector and is
// never surfaced (live rows carry a 4096-wide `embedding_4096`; the kb's
// entities/time_anchors arrays are objects, never long numeric runs).
const VECTOR_ARRAY_MIN_LEN = 64;

function isVectorArray(value) {
  if (!Array.isArray(value) || value.length <= VECTOR_ARRAY_MIN_LEN) return false;
  for (const x of value) {
    if (typeof x !== "number") return false;
  }
  return true;
}

/**
 * projectSourceRefs — pure `source_refs[]` projection. Exported on its own so
 * F3 (memory_walk_derivation) renders refs through THIS function and the two
 * tools cannot drift.
 *
 * Each stored ref passes through with `via` defaulted to "original" and
 * `corroboration_event_id` defaulted to null. Extra keys are kept on purpose
 * (`consent_basis`; the reconstructed-row form `{event_id, role}`) — they are
 * the provenance the tool exists to show.
 *
 * DELIBERATE DEVIATION from kb/mcp-surface.md ("source_refs is
 * corroboration-joined"): no corroboration join is implemented here because
 * (1) zero `policy_kind:"corroboration"` rows exist on the ledger (0 in the
 * first and last 400 MB, measured 2026-09-14) and the CORROBORATE branch of
 * distill-promote-fact.js:1865-1877 returns `corroborated_existing` without
 * appending one, and (2) the sole reader of such rows, hard-gates.js:554
 * (`corroborationByTarget` inside `_scanLedger`), needs a full-ledger scan,
 * which this tool must never trigger. When a corroboration writer lands, the
 * join belongs in this function and nowhere else.
 *
 * @param {object} row — a parsed ledger row.
 * @returns {Array<object>}
 */
export function projectSourceRefs(row) {
  if (row == null || !Array.isArray(row.source_refs)) return [];
  return row.source_refs.map((ref) => {
    const r = ref != null && typeof ref === "object" ? ref : {};
    return {
      ...r,
      via: r.via ?? "original",
      corroboration_event_id: r.corroboration_event_id ?? null,
    };
  });
}

/**
 * projectMemoryEvent — the full pure projection of a ledger row into the
 * memory_get response `data`. Exported for the hermetic test and for F3.
 *
 * @param {object} row — a parsed ledger row (fact | policy | reconstructed).
 * @param {{ derivedInto?: (string[]|null) }} [opts]
 *   `derivedInto` is the one-hop list of reconstructed ids whose
 *   `derived_from` names this row (from the derivation graph's reverseAdj),
 *   or `null` when the graph could not be loaded. `null` is preserved as-is:
 *   absence of the graph is never reported as an empty relation.
 * @returns {object}
 */
export function projectMemoryEvent(row, { derivedInto } = {}) {
  const r = row != null && typeof row === "object" ? row : {};
  const prov = r.provenance != null && typeof r.provenance === "object" ? r.provenance : {};

  // `features`: shallow copy of the stored block minus any embedding-sized
  // numeric array; `embedding_model_version` is always present (null when the
  // row has none). Top-level `embedding_4096`, `embedding` and `checksum` are
  // never copied — this projection only ever picks the keys named below.
  //
  // DELIBERATE DEVIATION from kb/mcp-surface.md (which types `entities` and
  // `time_anchors` as string[] and `valence` as number|null): the stored
  // shapes are objects (entity records, time-anchor records, a valence
  // block), and `attribution` / `salience` are stored objects too. They are
  // surfaced exactly as stored (lossless) rather than flattened into an
  // invented projection.
  const storedFeatures = r.features != null && typeof r.features === "object" ? r.features : {};
  const features = {};
  for (const [k, v] of Object.entries(storedFeatures)) {
    if (isVectorArray(v)) continue;
    features[k] = v;
  }
  features.embedding_model_version = storedFeatures.embedding_model_version ?? null;

  // Attribution keys (parties, direction, authored_by, chat_type, reply_to,
  // fwd_from) come from the SAME resolver the recall brief spreads into its
  // `provenance` (recall.js:4042-4058), so memory_get and memory_recall can
  // never disagree on who said what to whom. It never throws.
  const attribution = __resolveProvenanceAttribution(r);

  return {
    id: r.id,
    kind: r.kind,
    content: typeof r.content === "string" ? r.content : "",
    provenance: {
      source: r.source ?? prov.source ?? "memory_ledger",
      ts: r.ts ?? r.created_at ?? null,
      confidence: prov.confidence ?? null,
      agent_id: prov.agent_id ?? null,
      // The row's own value only. No conversation index lookup: F3 measured
      // synthesis/conversation index dead for this purpose (cache dated 2026-06-22,
      // null on daemon reconstructed rows and effectively all facts). The
      // thread relation is expressed by `derived_into` instead.
      conversation_id: prov.conversation_id ?? null,
      ...attribution,
    },
    source_refs: projectSourceRefs(r),
    derived_from: Array.isArray(r.derived_from) ? r.derived_from : [],
    // Additive (not in the kb shape): the live thread relation, one hop up the
    // reverse derivation adjacency. `null` ONLY when the graph failed to load.
    derived_into: derivedInto === undefined ? null : derivedInto,
    features,
    created_at: r.created_at ?? r.ts ?? null,
    // No helper resolves supersession: `memory_replace` / `memory_substitute`
    // are Phase 3 and unimplemented. Fact rows never carry these fields;
    // reconstructed rows stamp them null (reconstruction-emitter.js:991-993).
    superseded_by: r.superseded_by ?? null,
    reframed_by: r.reframed_by ?? null,
    rescinded_at: r.rescinded_at ?? null,
  };
}

async function handler(args) {
  assertObjectShape(args, "args", ["id"]);
  const id = assertNonEmptyString(args.id, "id");

  const ledgerPath = memoryLedgerPath();

  // Offset-index seek: the index is tail-merged to EOF on every call and each
  // hit is id-verified against the ledger bytes (ledger-offset-index.js:
  // 704-711), so a miss is authoritative. NO fallback to a full-ledger stream
  // on a miss — that is the recall-path wrapper's policy in index-cache.js
  // (:2618-2634, scoped stream over the missed ids) and would turn every unknown id into a
  // multi-second 3.67 GB scan an agent can trigger at will. NOT_FOUND is
  // O(index lookup). `indexed === false` means the ledger itself is missing.
  const r = seekLedgerRowsByIds(ledgerPath, new Set([id]));
  if (r.indexed === false || !r.byId.has(id)) {
    throw new ToolError(ERROR_CODES.NOT_FOUND, `memory event ${id} not found`);
  }
  const row = r.byId.get(id);

  // derived_into: one hop up the derivation graph's reverse adjacency, exactly
  // as recall loads it (recall.js:2675-2679). The loader is append-aware and
  // module-cached, so the warm cost is one Map.get; a fresh process seeds from
  // the storage sidecar plus the appended delta — the cost recall already
  // pays. Only `reverseAdj` and `kindOf` are read; no generator walkers.
  // Degrades to null on any throw (recall degrades the same way, :2666).
  let derivedInto;
  try {
    const graph = await loadOrRebuildDerivationGraph({
      ledgerPath,
      cachePath: join(STORAGE_DIR, "derivation-graph.cache.json"),
    });
    derivedInto = [...(graph.reverseAdj.get(id) ?? new Set())]
      .filter((c) => graph.kindOf.get(c) === "reconstructed")
      .sort();
  } catch (err) {
    derivedInto = null;
    console.error(
      `memory_get: derivation graph unavailable (${err && err.message ? err.message : err}); derived_into=null`,
    );
  }

  return ok(NAME, projectMemoryEvent(row, { derivedInto }));
}

export const TOOL = {
  name: NAME,
  description:
    "Fetch a single memory event by id with full provenance. Read-only. Use to answer 'where did you get that?' for a specific memory, or to render the read-before-destroy preview for memory_excise.",
  inputSchema: {
    type: "object",
    required: ["id"],
    additionalProperties: false,
    properties: {
      id: { type: "string" },
    },
  },
  handler,
};
