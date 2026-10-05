/** memory_connectors_list — see kb/mcp-surface.md § memory_connectors_list.
 *
 * Phase 2b: replaced the Phase 0 stub with the live read of connectors/<source>/
 * state.json via listInstalledConnectors. The TOOL.inputSchema is unchanged
 * (no args), so callers + the envelope-dispatch contract test continue to
 * pass without modification.
 *
 * Output shape (one entry per installed connector):
 *   {connectors: [
 *     {source, status, last_appended_ts, last_cursor_advance_ts},
 *     ...
 *   ]}
 *
 * status taxonomy (kb/connectors-survey.md → kill-switch + health):
 *   ok | degraded | stale | failed
 *
 * "Installed" = has a directory at connectors/<source>/ AND a state.json
 * inside. The four Phase 2b daemons each writeCursor() on first run, which
 * surfaces them here on the next memory_connectors_list call.
 */

import { ok } from "../envelope.js";
import { assertObjectShape, CAPS } from "../validation.js";
import { listInstalledConnectors } from "../connectors/index.js";
// F-INFRA-R40-TELEMETRY — read-only view of the live Stage-0 per-reason
// drop counters. Surfaced here so the operator can spot drop-rate
// anomalies without tailing the rotated JSONL sink directly.
import { snapshotCounters } from "../ingest/stage0/telemetry.js";
// F-NEW-W1-R42-HOSTNAME-OBSERVABILITY — surface the most-recent
// hostname-derived warning per source so the operator sees shared-
// machine drift in the health probe rather than only via stderr.
import { getHostnameWarnState } from "../identity/operator-identity.js";
// F-NEW-W2-CHAT-CC-HEALTH-PROBE — per-source effective_empty_rate over a
// rolling 7-day window. Surfaced as `source_health_probes` so the operator
// dashboard can flag a 99.75%-empty regression alongside the per-connector
// cursor state. status='degraded' is the operator-visible alarm.
import { computeEffectiveEmptyRatesForSources } from "../ingest/source-effective-empty-rate.js";
// F-NEW-W4-EMBED-COST-WIRING — per-(model, source) embed-cost counters.
// Surfaced as `embed_cost_counters` so the operator can quantify $/day
// per source and verify post-Stage-0 cost reductions are real, not
// inferred. Resets every flush window (FLUSH_EVERY_N or SIGTERM); the
// durable record lives in storage/telemetry/embed-cost-<UTC>.jsonl.
import { snapshotCounters as snapshotEmbedCostCounters } from "../observability/embed-cost.js";
// F-NEW-W7-CURSOR-LAG-CONNECTORS-LIST — surface the per-source
// cursor-lag snapshot here so memory_connectors_list is the canonical
// operational-health probe. Each entry carries:
//   {source, status, last_appended_ts, cursor_age_hours, ledger_growing,
//    lag_warn}
// The audit explicitly named memory_connectors_list as the tool the
// operator reads to see whether the watermark daemon is parked behind a
// growing connector tail. The pure snapshot function lives in the
// watermark daemon so the disk + cursor walk has a single source of
// truth; we re-export only the fields the operator dashboard needs.
import { computeCursorLagSnapshot } from "../../../daemons/watermark.js";
// B1 (task-hypergraph) — Telegram drain-liveness. Additive `drain_liveness`
// snapshot on the envelope; drain_stalled rolls into health.level="WARN"
// exactly as anyLagWarn does. Pure statSync-based probe, wrapped in try/catch
// so it can never crash the surface (mirrors the cursor_lag probe below).
import { computeTelegramDrainStatus } from "../connectors/telegram-drain-liveness.js";

const NAME = "memory_connectors_list";

async function handler(args) {
  assertObjectShape(args, "args", []);
  const rawConnectors = listInstalledConnectors();
  // Wave 9 — surface the captured_only mode + status. A captured_only
  // source's connector daemon keeps writing storage/sources/<source>.jsonl
  // (so its state.json health classifier above still reports ok/stale/
  // degraded based on connector-side cursor advance), but the watermark
  // daemon deliberately skips its cascade. The operator distinguishes
  // "we chose not to process this" from "this is broken" via the
  // mode + status fields here. status="captured_only" REPLACES the
  // upstream ok/stale/degraded label so dashboards reading status alone
  // do not page on a deliberately-cascade-skipped source.
  const capturedOnly =
    Array.isArray(CAPS.WATERMARK_CAPTURED_ONLY_SOURCES)
      ? new Set(CAPS.WATERMARK_CAPTURED_ONLY_SOURCES)
      : new Set();
  const connectors = rawConnectors.map((entry) => {
    if (capturedOnly.has(entry.source)) {
      return {
        ...entry,
        mode: "captured_only",
        status: "captured_only",
      };
    }
    return { ...entry, mode: "active" };
  });
  // Stage-0 counters are an additive health surface (sorted, deterministic
  // for envelope snapshot testing). An empty array is the natural cold-
  // start value, so existing callers ignoring `stage0_counters` continue
  // to work.
  const stage0Counters = snapshotCounters();
  // F-NEW-W1-R42-HOSTNAME-OBSERVABILITY: per-source last-warn overlay.
  // Empty {} when no warnings have fired. Each entry:
  //   {ts, fraction, total, matches, threshold_fraction}.
  // Aggregated into a single health.warnings[] array (one entry per
  // source) so callers iterate uniformly. Health level for the whole
  // payload is WARN if ANY source has a recorded warning, else OK; this
  // matches the critic_modifications requirement that
  // memory_connectors_list surface the hostname-warning state.
  const hostnameWarnState = getHostnameWarnState();
  const warnings = [];
  for (const [source, state] of Object.entries(hostnameWarnState)) {
    warnings.push({
      kind: "identity_hostname_dominance_warn",
      source,
      ts: state.ts,
      fraction: state.fraction,
      total: state.total,
      matches: state.matches,
      threshold_fraction: state.threshold_fraction,
    });
  }
  warnings.sort((a, b) => a.source.localeCompare(b.source));
  // F-NEW-W2-CHAT-CC-HEALTH-PROBE — per-source effective_empty_rate over a
  // rolling 7-day window. The probe scans storage/sources/<source>.jsonl
  // backward from EOF (bounded block reads, never a full-file read), counts
  // rows whose extracted user_text + assistant_text (or `text` for
  // chat-style sources) are both empty, and returns:
  //   {source, window_days, rows_in_window, empty_in_window,
  //    effective_empty_rate, status, note, window_covered_h, partial,
  //    bytes_scanned}
  // window_covered_h = hours of the window actually covered by the scan
  // (1-decimal, capped at window_days*24, null when no timestamped row was
  // seen); partial=true ONLY when the scan's byte budget stopped it before
  // the window cutoff / BOF (i.e. the rate covers less than the labeled
  // window); bytes_scanned = ledger bytes actually read. The whole snapshot
  // passes through unmodified as source_health_probes, so these fields flow
  // to callers automatically.
  // status='degraded' when the rate > 0.5. Empty / missing ledgers return
  // status='unknown' with a note so the absence is observable rather than
  // silent. We also escalate the overall health.level to WARN whenever
  // ANY probe is degraded so a single status-line caller sees the alarm.
  let sourceHealthProbes = {};
  try {
    sourceHealthProbes = computeEffectiveEmptyRatesForSources();
  } catch {
    // Probe must never crash the connectors-list surface. The absence of
    // entries is the operator's signal that the probe is unreachable for
    // this tick; we still emit the rest of the payload.
    sourceHealthProbes = {};
  }
  const anyEmptyDegraded = Object.values(sourceHealthProbes).some(
    (s) => s && s.status === "degraded"
  );
  const health = {
    level: warnings.length > 0 || anyEmptyDegraded ? "WARN" : "OK",
    warnings,
  };
  // F-NEW-W4-EMBED-COST-WIRING — surface per-(model, source) embed-cost
  // totals so the operator dashboard can read $/day per source without
  // tailing the daily JSONL sink. Each entry:
  //   {model, source, input_tokens, output_tokens, call_count,
  //    estimated_usd_today}
  // An empty array is the natural cold-start value (no embed has fired
  // since the last flush). The shape is additive; existing callers
  // ignoring `embed_cost_counters` continue to work.
  let embedCostCounters = [];
  try {
    embedCostCounters = snapshotEmbedCostCounters();
  } catch {
    // Counter read must never crash the surface. The absence of entries
    // is the operator's signal that the observability layer is degraded.
    embedCostCounters = [];
  }
  // F-NEW-W7-CURSOR-LAG-CONNECTORS-LIST — surface per-source cursor lag.
  // The pure snapshot reads each source ledger's tail row ts + the
  // matching watermark cursor's last_appended_ts; we project it into the
  // {source, status, last_appended_ts, cursor_age_hours, ledger_growing,
  //  lag_warn} shape the operator dashboard needs without forcing every
  // caller to re-derive cursor_age_hours from raw lag_ms. status here is
  // a coarse health rollup: "warn" when lag_warn is set, "ok" otherwise,
  // "unknown" when we have no cursor_ts to compare against. The probe
  // never throws; an empty array is the natural cold-start value.
  let cursorLag = [];
  try {
    const snapshot = computeCursorLagSnapshot();
    for (const entry of snapshot) {
      const cursorAgeHours =
        typeof entry.lag_ms === "number"
          ? Math.round((entry.lag_ms / 3600000) * 10) / 10
          : null;
      let status = "ok";
      if (entry.warned) {
        status = "warn";
      } else if (entry.cursor_ts == null || entry.lag_ms == null) {
        status = "unknown";
      }
      cursorLag.push({
        source: entry.source,
        status,
        last_appended_ts: entry.cursor_ts,
        cursor_age_hours: cursorAgeHours,
        ledger_growing: !!entry.ledger_growing,
        lag_warn: !!entry.warned,
      });
    }
  } catch {
    // Snapshot must never crash the surface. Empty array signals the
    // probe is unreachable; existing callers ignore the new field.
    cursorLag = [];
  }
  // Roll any lag_warn entry into health.level so single-status-line
  // callers see the alarm without re-walking the array.
  const anyLagWarn = cursorLag.some((e) => e.lag_warn);
  if (anyLagWarn && health.level === "OK") {
    health.level = "WARN";
  }
  // B1 (task-hypergraph) — Telegram drain-liveness snapshot. Additive field
  // (the envelope is open — see stage0_counters/cursor_lag above). Surfaces
  // the silent drain-stall class (source ledger frozen while the staging file
  // is still live) that W7 cursor-lag is structurally blind to. drain_stalled
  // rolls into health.level="WARN" exactly as anyLagWarn does. The probe never
  // throws; null is the natural degraded value.
  let drainLiveness = null;
  try {
    drainLiveness = computeTelegramDrainStatus();
  } catch {
    drainLiveness = null;
  }
  if (drainLiveness && drainLiveness.drain_stalled === true && health.level === "OK") {
    health.level = "WARN";
  }
  return ok(NAME, {
    connectors,
    stage0_counters: stage0Counters,
    source_health_probes: sourceHealthProbes,
    embed_cost_counters: embedCostCounters,
    cursor_lag: cursorLag,
    drain_liveness: drainLiveness,
    health,
  });
}

export const TOOL = {
  name: NAME,
  description: "List ingestion connectors and their state.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  handler,
};
