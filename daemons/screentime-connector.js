#!/usr/bin/env node
// screentime-connector.js — launchd entry point for the Phase 2b ScreenTime
// connector daemon. Thin shim that loads mcp/lib/connectors/screentime.js
// and runs its forever-loop.
//
// Authoritative spec: kb/connectors-survey.md § screentime-knowledgec.
// Connector module:   mcp/lib/connectors/screentime.js
//
// Why the shim lives here (NOT inside mcp/): launchd plists in
// ~/Library/LaunchAgents/ name an absolute ProgramArguments path; the
// `daemons/` directory is the canonical location for every memory-system
// launchd entry point (matches watermark.js + distillation-supervisor.js).
// Keeping the production logic inside mcp/lib/connectors/ keeps the test
// surface unified — `npm test` in mcp/ exercises the same module the
// daemon loads.
//
// CLI shape: this file accepts NO arguments. Behaviour is fixed —
// runForever() with the default 30s poll interval. Graceful shutdown on
// SIGTERM / SIGINT via an AbortController.

import { ScreenTimeConnector } from "../mcp/lib/connectors/screentime.js";

const c = new ScreenTimeConnector({});
const ac = new AbortController();
function shutdown(sig) {
  process.stderr.write(`[screentime-connector] received ${sig}, aborting\n`);
  ac.abort();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

(async () => {
  try {
    await c.runForever({ signal: ac.signal, intervalMs: 30000 });
    process.exit(0);
  } catch (err) {
    process.stderr.write(`[screentime-connector] fatal: ${String(err && err.stack || err)}\n`);
    process.exit(1);
  }
})();
