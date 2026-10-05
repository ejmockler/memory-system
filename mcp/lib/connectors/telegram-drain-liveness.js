// telegram-drain-liveness.js — B1 (task-hypergraph) drain-liveness detector.
//
// Closes the silent-stall class discovered 2026-07-06: the Python Telethon
// tail keeps appending to the staging file
// (<MEMORY_ROOT>/storage/tmp/telegram-staging.jsonl by default) while the Node drain into storage/sources/telegram.jsonl freezes, and NO
// health surface notices — telegram.jsonl was frozen at Jun 25 for 11 days
// while capture ran fine.
//
// THE SIGNAL — invert W7's growth gate. daemons/watermark.js
// computeCursorLagSnapshot warns only when the ledger is GROWING
// (`warned = lag>24h AND ledger_growing`), so a FROZEN ledger has
// ledger_growing=false and is structurally invisible to it. Here we fire when
// the SOURCE ledger is frozen (stale mtime) WHILE upstream capture (the
// staging file) is still LIVE (fresh mtime) — the exact shape of the stall.
// Gating on staging-live means a quiet ledger during a genuinely quiet period
// does NOT false-fire, because the staging file is quiet then too.
//
// HARD RULE (never readFileSync a ledger): storage/sources/telegram.jsonl can
// exceed Node's string cap. We only statSync the source ledger and staging
// file (mtimeMs + size — mirrors readLedgerTailTs's stat discipline in
// watermark.js) and NEVER read their content. The only file we read is the
// connector state.json cursor, which is tiny.
//
// Pure + side-effect-free: no writes, no daemon RPC. `now` is injectable so
// the detector is deterministic under hermetic tests.

import { existsSync, readFileSync, statSync } from "node:fs";

import { sourceLedgerPath as defaultSourceLedgerPath, connectorStatePath } from "../config.js";
import { CAPS } from "../validation.js";
// Staging path the Python helper writes to. The detector has no default of its
// own: it shares telegram.js's defaultStagingFile(), so the drain and its stall
// detector resolve the same file (TELEGRAM_STAGING_FILE when set, otherwise
// <MEMORY_ROOT>/storage/tmp/telegram-staging.jsonl) in every process.
import { defaultStagingFile } from "./telegram.js";

const SOURCE = "telegram";

// statSync wrapper — never throws. Absent/error => {exists:false, mtimeMs:0,
// size:0} so callers treat a missing file as "no signal" rather than crashing.
function safeStat(path) {
  try {
    const st = statSync(path);
    return { exists: true, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return { exists: false, mtimeMs: 0, size: 0 };
  }
}

// computeTelegramDrainStatus — pure detector. Returns the closed snapshot the
// B1 spec pins. See module header for the drain_stalled semantics.
export function computeTelegramDrainStatus({
  now = new Date(),
  sourceLedgerPath: ledgerPathArg,
  cursorPath: cursorPathArg,
  stagingFile: stagingFileArg,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const ledgerPath = ledgerPathArg || defaultSourceLedgerPath(SOURCE);
  const cursorPath = cursorPathArg || connectorStatePath(SOURCE);
  const stagingFile = stagingFileArg || defaultStagingFile();

  // Connector cursor — the tiny JSON state file (never a ledger; plain read is
  // fine). Absent => the connector is not installed.
  let state = null;
  const installed = existsSync(cursorPath);
  if (installed) {
    try {
      const raw = readFileSync(cursorPath, "utf8");
      state = raw === "" ? null : JSON.parse(raw);
    } catch {
      state = null;
    }
  }

  const stagingOffset =
    state && Number.isInteger(state.staging_offset) && state.staging_offset >= 0
      ? state.staging_offset
      : 0;
  const lastAppendedTs =
    state && typeof state.last_appended_ts === "string" ? state.last_appended_ts : null;
  const lastPolledTs =
    state && typeof state.last_polled_ts === "string" ? state.last_polled_ts : null;

  // Staging file — upstream capture liveness. statSync only (mtime + size);
  // the file itself is never read.
  const stagingStat = safeStat(stagingFile);
  const stagingPresent = stagingStat.exists;
  const stagingSize = stagingStat.size;
  const stagingMtimeMs = stagingStat.mtimeMs;

  // Source ledger — drain output freshness. statSync only. Absent/empty is
  // treated as no-signal (ledger_age_ms=null => never drain_stalled).
  const ledgerStat = safeStat(ledgerPath);
  const ledgerMtimeMs = ledgerStat.mtimeMs;
  const ledgerSize = ledgerStat.size;

  const ledgerAgeMs = ledgerMtimeMs > 0 ? nowMs - ledgerMtimeMs : null;
  const stagingAgeMs = stagingMtimeMs > 0 ? nowMs - stagingMtimeMs : null;
  const unconsumedBytes = Math.max(0, stagingSize - stagingOffset);

  // drain_stalled — the crux. Upstream capture is LIVE (staging mtime fresh)
  // while the drain output is FROZEN (source-ledger mtime stale).
  const stagingLive =
    stagingAgeMs != null && stagingAgeMs < CAPS.TELEGRAM_STAGING_LIVE_WINDOW_MS;
  const ledgerFrozen =
    ledgerAgeMs != null && ledgerAgeMs > CAPS.TELEGRAM_DRAIN_STALL_THRESHOLD_MS;
  const drainStalled = !!(installed && stagingPresent && stagingLive && ledgerFrozen);

  // status — reuse the EXISTING telegram_connector_status enum
  // (kb/mcp-surface.md:969). No new enum value; a stall maps to "unhealthy"
  // and is disambiguated by the telegram_drain_stalled: health_note.
  let status;
  if (!installed) status = "not_installed";
  else if (drainStalled) status = "unhealthy";
  else status = "running";

  return {
    installed,
    staging_present: stagingPresent,
    staging_mtime_ms: stagingMtimeMs,
    staging_size: stagingSize,
    ledger_mtime_ms: ledgerMtimeMs,
    ledger_size: ledgerSize,
    ledger_age_ms: ledgerAgeMs,
    staging_age_ms: stagingAgeMs,
    last_appended_ts: lastAppendedTs,
    last_polled_ts: lastPolledTs,
    staging_offset: stagingOffset,
    unconsumed_bytes: unconsumedBytes,
    drain_stalled: drainStalled,
    status,
  };
}
