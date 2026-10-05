// server-lifecycle.test.mjs — L1 lifecycle gates for the stdio MCP server.
//
// Spawns the REAL mcp/server.js over piped stdio against a hermetic
// mkdtempSync MEMORY_ROOT (never the live <checkout> data — boot only
// touches the fixture nonce store) and proves the server exits
// deterministically (code 0, bounded grace) when its client goes away:
//   T1 normal serving regression guard (initialize + tools/list, no
//      overzealous exit while stdin is open and idle)
//   T2 stdin EOF with the event loop held open by the preload fixture
//   T3 SIGTERM / SIGINT graceful exit (code 0, signal null)
//   T4 orphan-ppid watchdog (reparented to pid 1, stdin still open)
//
// Gate honesty: T2 times out, T3 dies by signal (code null), and T4 never
// exits when run against pre-fix server.js — each was verified to FAIL on
// the unmodified server before the lifecycle fix landed. The EOF gate is
// honest ONLY because fixtures/lifecycle-hold-loop.mjs holds the loop open;
// a bare idle server already exits on EOF because its event loop empties.
//
// Hermetic: fixture root under mkdtempSync, removed on exit
// (auto-drain.test.mjs discipline). node:test + node:assert/strict.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_DIR = resolve(__dirname, "..");
const HOLD_LOOP_FIXTURE = "./test/fixtures/lifecycle-hold-loop.mjs";

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), "server-lifecycle-"));
process.on("exit", () => {
  try { rmSync(FIXTURE_ROOT, { recursive: true, force: true }); } catch {}
});

let rootSeq = 0;

// One hermetic MEMORY_ROOT per spawn. The policy/ dir is REQUIRED: boot
// opens policy/consumed-nonces.lock with O_CREAT and dies ENOENT without
// the parent directory.
function makeRoot() {
  const root = join(FIXTURE_ROOT, `root-${rootSeq++}`);
  mkdirSync(join(root, "policy"), { recursive: true });
  return root;
}

function spawnServer({ root, extraEnv = {}, nodeArgs = [] }) {
  return spawn(process.execPath, [...nodeArgs, "server.js"], {
    cwd: MCP_DIR,
    env: { ...process.env, MEMORY_ROOT: root, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

// Promise-based line reader over a stdout stream.
function lineReader(stream) {
  let buf = "";
  const lines = [];
  const waiters = [];
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const w = waiters.shift();
      if (w) w(line);
      else lines.push(line);
    }
  });
  return {
    nextLine(timeoutMs, label) {
      if (lines.length > 0) return Promise.resolve(lines.shift());
      return new Promise((resolveLine, reject) => {
        const t = setTimeout(
          () => reject(new Error(`timeout (${timeoutMs}ms) waiting for ${label}`)),
          timeoutMs,
        );
        waiters.push((line) => {
          clearTimeout(t);
          resolveLine(line);
        });
      });
    },
  };
}

// Read stdout lines until a JSON-RPC response with the given id arrives.
async function awaitResponse(reader, id, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timeout (${timeoutMs}ms) waiting for ${label}`);
    const line = await reader.nextLine(remaining, label);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // not JSON-RPC; skip
    }
    if (msg.id === id) return msg;
  }
}

// MCP initialize handshake (protocolVersion 2024-11-05) + initialized note.
async function handshake(child, reader, timeoutMs = 2000) {
  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "server-lifecycle-test", version: "0.0.1" },
      },
    }) + "\n",
  );
  const res = await awaitResponse(reader, 1, timeoutMs, "initialize response");
  assert.ok(res.result, `initialize returned a result (got: ${JSON.stringify(res)})`);
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
  );
  return res;
}

function waitForExit(child, timeoutMs, label) {
  return new Promise((resolveExit, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const t = setTimeout(
      () => reject(new Error(`timeout (${timeoutMs}ms) waiting for ${label} to exit`)),
      timeoutMs,
    );
    child.once("exit", (code, signal) => {
      clearTimeout(t);
      resolveExit({ code, signal });
    });
  });
}

function reap(child) {
  try { child.kill("SIGKILL"); } catch {}
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e && e.code === "ESRCH") return false;
    return true; // EPERM etc: process exists
  }
}

// ---------------------------------------------------------------------------
// T1 — normal serving regression guard: initialize responds within 2s,
// tools/list returns a non-empty tools array, and the server does NOT exit
// while stdin is open and idle.
// ---------------------------------------------------------------------------
test("T1 normal serving: handshake, tools/list, no overzealous exit", async () => {
  const child = spawnServer({ root: makeRoot() });
  try {
    const reader = lineReader(child.stdout);
    await handshake(child, reader, 2000);

    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n",
    );
    const res = await awaitResponse(reader, 2, 2000, "tools/list response");
    assert.ok(Array.isArray(res.result?.tools), "tools/list returned a tools array");
    assert.ok(res.result.tools.length > 0, "tools array is non-empty");

    // stdin is open and idle — the server must still be alive ~1s later.
    await sleep(1000);
    assert.equal(child.exitCode, null, "server exited while stdin was open and idle");
    assert.equal(child.signalCode, null, "server died by signal while idle");
  } finally {
    reap(child);
    await waitForExit(child, 2000, "T1 server (reap)").catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// T2 — stdin EOF with the event loop held open: exits code 0 within 8s.
// FAILS on pre-fix code: the preload fixture's ref'd interval keeps the
// orphan alive forever, so waitForExit times out.
// ---------------------------------------------------------------------------
test("T2 stdin EOF with held event loop exits 0 within grace", async () => {
  const child = spawnServer({
    root: makeRoot(),
    nodeArgs: ["--import", HOLD_LOOP_FIXTURE],
    extraEnv: { MEMORY_MCP_SHUTDOWN_GRACE_MS: "3000" },
  });
  try {
    const reader = lineReader(child.stdout);
    await handshake(child, reader, 2000);

    child.stdin.end();
    const { code, signal } = await waitForExit(child, 8000, "server after stdin EOF");
    assert.equal(code, 0, `expected graceful exit 0 after stdin EOF, got code=${code}`);
    assert.equal(signal, null, `expected no signal death, got signal=${signal}`);
  } finally {
    reap(child);
  }
});

// ---------------------------------------------------------------------------
// T3 — SIGTERM / SIGINT graceful: code === 0, signal === null, within 8s.
// FAILS on pre-fix code: default handler = death-by-signal (code null).
// ---------------------------------------------------------------------------
async function assertGracefulOnSignal(sig) {
  const child = spawnServer({
    root: makeRoot(),
    nodeArgs: ["--import", HOLD_LOOP_FIXTURE],
    extraEnv: { MEMORY_MCP_SHUTDOWN_GRACE_MS: "3000" },
  });
  try {
    const reader = lineReader(child.stdout);
    await handshake(child, reader, 2000);

    child.kill(sig);
    const { code, signal } = await waitForExit(child, 8000, `server after ${sig}`);
    assert.equal(code, 0, `expected graceful exit 0 after ${sig}, got code=${code}`);
    assert.equal(signal, null, `expected signal null after ${sig}, got signal=${signal}`);
  } finally {
    reap(child);
  }
}

test("T3a SIGTERM produces graceful exit (code 0, signal null)", async () => {
  await assertGracefulOnSignal("SIGTERM");
});

test("T3b SIGINT produces graceful exit (code 0, signal null)", async () => {
  await assertGracefulOnSignal("SIGINT");
});

// ---------------------------------------------------------------------------
// T4 — orphan ppid watchdog: an intermediate parent spawns server.js with
// stdio "inherit", so the server's stdin is the pipe THIS TEST holds open —
// killing the parent produces no EOF. The server, reparented to launchd
// (pid 1), must exit within 5s under MEMORY_MCP_PPID_POLL_MS=150.
// FAILS on pre-fix code: the orphan never exits.
// ---------------------------------------------------------------------------
test("T4 orphaned server (ppid -> 1, stdin still open) exits within 5s", async () => {
  const root = makeRoot();
  const pidFile = join(root, "server.pid");
  const interScript = `
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    const child = spawn(process.execPath,
      ["--import", ${JSON.stringify(HOLD_LOOP_FIXTURE)}, "server.js"],
      { stdio: "inherit" });
    writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    setInterval(() => {}, 1 << 30);
  `;
  const inter = spawn(process.execPath, ["-e", interScript], {
    cwd: MCP_DIR,
    env: {
      ...process.env,
      MEMORY_ROOT: root,
      MEMORY_MCP_PPID_POLL_MS: "150",
      MEMORY_MCP_SHUTDOWN_GRACE_MS: "3000",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let serverPid = null;
  try {
    // Wait for the intermediate to report the server pid.
    const pidDeadline = Date.now() + 5000;
    while (!existsSync(pidFile)) {
      assert.ok(Date.now() < pidDeadline, "timed out waiting for server pid file");
      await sleep(50);
    }
    serverPid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isInteger(serverPid) && serverPid > 1, `bad server pid: ${serverPid}`);

    // Give the server a beat to boot, then orphan it. Its stdin (inherited
    // pipe) stays open — the test process still holds the write end.
    await sleep(500);
    assert.ok(pidAlive(serverPid), "server should be alive before orphaning");
    inter.kill("SIGKILL");

    const deadline = Date.now() + 5000;
    while (pidAlive(serverPid)) {
      assert.ok(
        Date.now() < deadline,
        `orphaned server pid ${serverPid} still alive 5000ms after parent death`,
      );
      await sleep(100);
    }
  } finally {
    // A failing run must leave no stray process.
    reap(inter);
    if (serverPid !== null) {
      try { process.kill(serverPid, "SIGKILL"); } catch {}
    }
  }
});
