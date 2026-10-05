#!/usr/bin/env node
// stdio MCP entry point. Wires @modelcontextprotocol/sdk to dispatch.
// Conventional layout: this entry point owns lifecycle, lib/dispatch.js owns the tools.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { executeTool, listTools } from "./lib/dispatch.js";
import {
  ensureStoreReady,
  pruneExpired,
  NONCE_STORE_CORRUPTED,
} from "./lib/nonce-store.js";

const SERVER_NAME = "memory";
const SERVER_VERSION = "0.0.1";

// ---------------------------------------------------------------------------
// Lifecycle: deterministic shutdown when the client goes away.
//
// The SDK's StdioServerTransport listens only on stdin "data"/"error" — it
// never sees EOF — and lib/observability/embed-cost.js lazily registers
// SIGTERM/SIGINT handlers that flush but never exit (disabling Node's default
// die-on-signal once any embed happens). Without the wiring below, a server
// whose event loop is held open by any ref'd handle lingers forever as a
// multi-GB orphan. Triggers: stdin end/close, SIGTERM, SIGINT, and a ppid
// watchdog for reparenting to pid 1 (macOS launchd adopts orphans).
//
// Shutdown drains in-flight CallTool requests and the stdout pipe, then
// exits 0. It deliberately does NOT flush recall indices: index-cache.js's
// flush timers are unref()'d and pending adds are already durable in the
// fsync'd journal replayed by loadIndices — process.exit(0) is the correct
// cancellation (a flush-on-exit would reinstate the 1.89GB hnsw.bin rewrite
// and race the journal truncate).
const GRACE_MS = Number(process.env.MEMORY_MCP_SHUTDOWN_GRACE_MS) || 5000;
const PPID_POLL_MS = Number(process.env.MEMORY_MCP_PPID_POLL_MS) || 15000;

let inFlight = 0;
let shuttingDown = false;

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`${SERVER_NAME} MCP: shutting down (${reason})\n`);

  // Hard bound: exit even if drain never completes. unref()'d so it cannot
  // itself keep the process alive.
  setTimeout(() => process.exit(0), GRACE_MS).unref();

  // Stop intake. Do NOT call server.close() mid-drain and do NOT touch
  // transport.onclose — the SDK Server owns it.
  process.stdin.pause();

  // Drain: wait until no CallTool handler is in flight AND any response
  // already handed to the stdout pipe has flushed, then exit on the next
  // tick. All graceful paths exit 0. Exiting via timer/setImmediate also
  // guarantees we are at least one tick past signal receipt, so sibling
  // synchronous signal handlers (embed-cost.js flush) complete first.
  const drain = setInterval(() => {
    if (inFlight === 0 && process.stdout.writableLength === 0) {
      clearInterval(drain);
      setImmediate(() => process.exit(0));
    }
  }, 25);
}

// round-15 H2: consumed-nonce store recovery + TTL prune at MCP startup,
// BEFORE the JSON-RPC handshake. Without this, a torn-tail line left by a
// crashed checkAndConsume would brick the first privileged tool call until
// an operator intervenes — every memory_distill_promote_fact would throw
// out of scanForMatch on a malformed line, never recording a result.
//
// Contract (mirrors distillation-supervisor.js's ensureNonceStoreReadyOrExit):
//   - tail corruption: log to stderr, proceed; the store has been truncated
//     to the last good offset and a policy.token.rejected
//     reason=corrupt_tail_truncated row was emitted by ensureStoreReady.
//   - mid-file corruption: ensureStoreReady throws after emitting
//     policy.token.rejected reason=nonce_store_corrupted; we exit non-zero so
//     the MCP host (Claude Code / supervisor child spawn) surfaces the
//     failure rather than the server quietly serving requests that will all
//     reject. Recognised ONLY by the error's code === NONCE_STORE_CORRUPTED.
//   - any other failure (policy dir cannot be created, permission denied,
//     lock contention ...): also exit non-zero, but report the real cause —
//     never the corruption message. A missing policy dir is not a failure:
//     ensureStoreReady creates it (0700) on first boot.
//   - pruneExpired: best-effort disk-hygiene call; on failure log + proceed.
function ensureNonceStoreReadyOrExit() {
  try {
    const res = ensureStoreReady();
    if (res && res.truncated_corrupt_tail === true) {
      process.stderr.write(
        `${SERVER_NAME} MCP: consumed-nonces.jsonl tail truncated at startup (corrupt_tail_truncated)\n`,
      );
    }
    if (res && res.reclaimed_stale_lock === true) {
      process.stderr.write(
        `${SERVER_NAME} MCP: consumed-nonces.lock reclaimed at startup (stale holder)\n`,
      );
    }
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (e && e.code === NONCE_STORE_CORRUPTED) {
      process.stderr.write(
        `${SERVER_NAME} MCP: nonce-store mid-file corruption — refusing to start: ${msg}\n`,
      );
    } else {
      const code = e && e.code ? `${e.code}: ` : "";
      const shown = code && msg.startsWith(code) ? msg : `${code}${msg}`;
      process.stderr.write(
        `${SERVER_NAME} MCP: nonce-store not ready (${shown}) — refusing to start\n`,
      );
    }
    process.exit(1);
  }
  try {
    pruneExpired();
  } catch (e) {
    process.stderr.write(
      `${SERVER_NAME} MCP: pruneExpired failed (non-fatal): ${e && e.message ? e.message : e}\n`,
    );
  }
}

async function main() {
  ensureNonceStoreReadyOrExit();

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    inFlight += 1;
    try {
      const { name, arguments: args } = req.params;
      const envelope = await executeTool(name, args || {});
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        isError: envelope.ok === false,
      };
    } finally {
      inFlight -= 1;
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Lifecycle wiring — handler registrations only, no I/O at boot.
  process.stdin.on("end", () => shutdown("stdin-eof"));
  process.stdin.on("close", () => shutdown("stdin-eof"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Orphan watchdog: macOS reparents orphans to launchd (pid 1). The
  // initialPpid !== 1 guard protects a legitimately launchd-spawned server.
  const initialPpid = process.ppid;
  setInterval(() => {
    if (initialPpid !== 1 && process.ppid === 1) shutdown("orphaned");
  }, PPID_POLL_MS).unref();

  process.stderr.write(`${SERVER_NAME} MCP server running (stdio) v${SERVER_VERSION}\n`);
}

main().catch((err) => {
  process.stderr.write(`memory MCP fatal: ${err.stack || err.message || err}\n`);
  process.exit(1);
});
