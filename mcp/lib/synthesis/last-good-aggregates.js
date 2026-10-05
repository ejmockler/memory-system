// last-good-aggregates.js — the served-on-degrade synthesis envelope cache.
//
// EXTRACTED from mcp/lib/tools/health.js (where both helpers were file-local)
// so the detached rebuild child can write the cache with the SAME
// implementation the inline path uses. Duplicating the serialization into the
// child's generated source would reintroduce exactly the drift class this
// module exists to prevent.
//
// WHY THE CHILD NEEDS IT. health.js has two synthesis paths:
//
//   inline (healthy)  — computes coverage + drift, saveState, AND writes
//                       last-good.json.
//   degrade           — pushes a `synthesis_state_rebuilding:` note, SERVES
//                       last-good.json, and spawns a detached rebuild child.
//
// The child previously called only updateStateFromLedgers + saveState, so it
// repaired state.json but never refreshed last-good.json. Since last-good was
// written solely by the inline path, any run of consecutive degraded calls
// froze the served aggregates indefinitely: observed with state.json current
// while last-good.json's saved_at was nearly two weeks old, a stale
// dashboard reported as current. The inline path is only
// reachable when the pending append delta is under the 16 MiB budget
// (health.js planReducerFold), and memory.jsonl grows tens of MB/day, so that
// window shuts within hours of each fold and nothing reopens it on a
// schedule. Self-perpetuating.
//
// Reads are fail-soft (anything malformed → null: the degrade path then
// serves nulls, exactly the pre-H2 unreachable-probe shape). Writes are
// atomic (tmp + rename) so a crashed writer can never leave a torn last-good
// behind. The tmp name carries the writer's pid so the inline path and a
// detached child racing to refresh cannot collide on the same temp file.

import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";

export function readLastGoodAggregates(lastGoodPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(lastGoodPath, "utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const covOk =
    parsed.synthesis_coverage === null ||
    (typeof parsed.synthesis_coverage === "object" && parsed.synthesis_coverage !== null);
  const driftOk =
    parsed.drift_alerts === null ||
    (typeof parsed.drift_alerts === "object" && parsed.drift_alerts !== null);
  if (!covOk || !driftOk) return null;
  // saved_at is the WRITE watermark (distinct from synthesis_coverage.built_at,
  // the compute watermark). The degrade path in health.js compares it against
  // rebuild-outcome.json's finished_at to decide whether a failed rebuild has
  // since been superseded by a successful last-good refresh. String when
  // present, null otherwise — never a throw.
  return {
    saved_at: typeof parsed.saved_at === "string" ? parsed.saved_at : null,
    synthesis_coverage: parsed.synthesis_coverage,
    drift_alerts: parsed.drift_alerts,
  };
}

// One tmp+rename implementation shared by last-good.json (below) and by
// rebuild-outcome.json (health.js scheduleReducerStateRebuild: written by the
// detached child in its finally, and by the parent on spawn failure). The tmp
// name carries the writer's pid so racing writers never collide on the same
// temp file. Best-effort: a failed write cleans its tmp and returns false; it
// never throws, because both callers run inside cleanup paths where a throw
// would skip the marker unlink that follows.
export function writeJsonAtomic(path, obj) {
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort tmp cleanup */
    }
    return false;
  }
}

export function writeLastGoodAggregates(lastGoodPath, synthesisCoverage, driftAlerts) {
  writeJsonAtomic(lastGoodPath, {
    saved_at: new Date().toISOString(),
    synthesis_coverage: synthesisCoverage,
    drift_alerts: driftAlerts,
  });
}
