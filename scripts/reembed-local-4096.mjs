#!/usr/bin/env node
// reembed-local-4096.mjs — DEPRECATED DUPLICATE (DO NOT EDIT).
//
// WU-dense-reembed-infra reconciled the re-embed pipeline to a SINGLE canonical
// producer so the sidecar schema cannot drift between two forks. This file used
// to be a 184-line fork that HARD-TRUNCATED content to MAX_CHARS=4000 (~1000
// tokens, ~40x below the model's 40,960-token ceiling), embedding the 47 giants
// from only their opening fragment and producing semantically wrong vectors.
//
// The canonical, full-fidelity, turn-aware, length-bucketed, multi-vector
// implementation now lives at:
//
//     mcp/scripts/reembed-local-4096.mjs
//
// Run that instead. This stub re-exports the canonical pure helpers (so any
// importer of THIS path keeps working) and, when invoked directly, prints a
// pointer and exits non-zero rather than silently running the old truncating
// path. Thesis #1: the sidecar is the single derived, model-versioned
// projection — one producer, one schema.

export {
  chunksFor,
  splitTurns,
  batchSizeForCharLen,
  WINDOW,
  OVERLAP,
  TURN_DELIMITERS,
  CHARS_PER_TOKEN,
  MODEL_CONTEXT_TOKENS,
} from "../mcp/scripts/reembed-local-4096.mjs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Main-module check that survives spaces and symlinks in the invocation path:
// compare real filesystem paths, never a hand-built file:// string.
const INVOKED_DIRECTLY = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (INVOKED_DIRECTLY) {
  process.stderr.write(
    "scripts/reembed-local-4096.mjs is DEPRECATED.\n" +
      "Use the canonical full-fidelity copy:\n" +
      "    node mcp/scripts/reembed-local-4096.mjs [--limit N | --sample-longest | --build-hnsw]\n",
  );
  process.exit(2);
}
