#!/usr/bin/env node
// scripts/smoke.mjs — first-run smoke test: put one memory, recall it.
//
//   node scripts/smoke.mjs
//
// Starts the MCP server (mcp/server.js, resolved relative to this file) on a
// throwaway MEMORY_ROOT under the OS temp dir, speaks MCP JSON-RPC over stdio
// (initialize, notifications/initialized, tools/call memory_put, then
// tools/call memory_recall, retried a few times), prints exactly ONE line of
// JSON and exits:
//
//   0  the recall response contained the text that was put
//   1  anything else: put refused, recall came back without it, the server
//      exited early, or the run timed out
//
// It needs no embedding server, no background daemon and no network: on a
// fresh root the put is indexed lexically at write time and recall serves it
// lexical-only, marked degraded (reason dense_leg_unservable). The caller's
// environment is passed through unchanged apart from MEMORY_ROOT, and this
// script sets no feature flags of its own, so e.g. MEMORY_PUT_ENABLED=0 makes
// it fail (put refused) as it should.
//
// Node standard library only; all text written is synthetic.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "mcp",
  "server.js",
);
const CODEWORD = "heron-basalt-lantern";
// The hit test looks for the whole put sentence, not just the codeword: the
// recall query below also carries the codeword, so a response that merely
// echoed the query back could never be mistaken for a served memory.
const PUT_TEXT = `The first-run smoke test codeword is ${CODEWORD}.`;
const CONVERSATION_ID = "smoke-conv";
const OVERALL_TIMEOUT_MS = 120_000;
const RECALL_ATTEMPTS = 4;
const RECALL_RETRY_DELAY_MS = 3_000;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-smoke-"));
const child = spawn(process.execPath, [SERVER], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, MEMORY_ROOT: root },
});

let stdoutBuf = "";
let stderrBuf = "";
let nextId = 1;
let finished = false;
const pending = new Map();

const stderrTail = () =>
  stderrBuf.trim().split("\n").slice(-2).join(" | ").slice(0, 240);

function finish(ok, summary) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  const cleanup = () => {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // best-effort: a leftover temp dir must not change the verdict
    }
    console.log(JSON.stringify({ ok, summary }));
    process.exit(ok ? 0 : 1);
  };
  if (child.exitCode !== null || child.signalCode !== null) return cleanup();
  // Remove the root only after the server is gone, so it cannot re-create it.
  const hardKill = setTimeout(() => child.kill("SIGKILL"), 2_000);
  child.once("exit", () => {
    clearTimeout(hardKill);
    cleanup();
  });
  child.kill("SIGTERM");
}

const timer = setTimeout(
  () => finish(false, `timeout after ${OVERALL_TIMEOUT_MS}ms; stderr: ${stderrTail()}`),
  OVERALL_TIMEOUT_MS,
);

child.stderr.on("data", (d) => {
  stderrBuf = (stderrBuf + d).slice(-8_000);
});
child.stdout.on("data", (d) => {
  stdoutBuf += d;
  let i;
  while ((i = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, i);
    stdoutBuf = stdoutBuf.slice(i + 1);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // not a JSON-RPC frame
    }
    if (msg && msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
child.on("error", (e) => finish(false, `server failed to start: ${e.message}`));
child.on("exit", (code, signal) => {
  if (!finished) finish(false, `server exited (${code ?? signal}): ${stderrTail()}`);
});
child.stdin.on("error", () => {
  // EPIPE after an early server exit; the exit handler reports it
});

const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
const rpc = (method, params) => {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const textOf = (r) =>
  r.result?.content?.[0]?.text || JSON.stringify(r.error || r.result || {});

(async () => {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const put = await rpc("tools/call", {
    name: "memory_put",
    arguments: {
      content: PUT_TEXT,
      provenance: { agent_id: "smoke", conversation_id: CONVERSATION_ID },
    },
  });
  const putText = textOf(put);
  let putOk = !put.error && !put.result?.isError;
  try {
    if (JSON.parse(putText).ok === false) putOk = false;
  } catch {
    // non-JSON tool text: fall back to the protocol-level flags above
  }
  if (!putOk) return finish(false, `put refused: ${putText.slice(0, 200)}`);

  let recallText = "";
  for (let attempt = 0; attempt < RECALL_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RECALL_RETRY_DELAY_MS);
    const recall = await rpc("tools/call", {
      name: "memory_recall",
      arguments: {
        conversation_id: CONVERSATION_ID,
        surrounding_context: {
          recent_turns: [],
          agent_role: "assistant",
          current_query: `What is the first-run smoke test codeword? ${CODEWORD}`,
          time: new Date().toISOString(),
        },
      },
    });
    recallText = textOf(recall);
    if (recallText.includes(PUT_TEXT)) {
      const degraded = /"degraded_recall":true/.test(recallText);
      return finish(
        true,
        `put then recall returned the put text${degraded ? " (lexical-only, degraded_recall)" : ""}`,
      );
    }
  }
  const reason = recallText.match(/"degraded_reason":"[^"]*"/);
  finish(false, `put ok, recall empty: ${reason ? reason[0] : recallText.slice(0, 200)}`);
})().catch((e) => finish(false, `smoke crashed: ${e && e.message ? e.message : String(e)}`));
