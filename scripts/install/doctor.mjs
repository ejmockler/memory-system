#!/usr/bin/env node
// doctor.mjs: check an install and print a short checklist.
//
//   node scripts/install/doctor.mjs [--root <checkout>] [--data-root <dir>] [--node-floor <x.y.z>]
//
//   --root        the checkout to check (default: the checkout this file is in)
//   --data-root   where ledgers, storage, policy and config live (default:
//                 MEMORY_ROOT when it is set, otherwise --root)
//   --node-floor  lowest supported Node.js version (default: 22.18.0)
//
// Core checks decide the exit code (0 = the core is usable, 1 = it is not):
//   node version, dependencies load, server handshake, data root writable.
// Optional checks are reported as present or absent and never change the exit
// code: the two Python environments, rendered service files, the operator
// identity config and the secrets file.
//
// The handshake starts mcp/server.js, asks for its tool list and stops it. It
// stores no memory. The data root is --data-root, else MEMORY_ROOT when it is
// set (an install whose data lives outside the checkout), else the checkout. It
// is handed to the server the handshake starts, and the write test touches only
// that directory; every other environment setting passes through untouched. This file
// prints paths and ok/missing only, never the contents of a file, and it never
// looks at or changes installed background services.
//
// Node builtins only.

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DATA_DIRS = ["policy", "storage", "storage/sources", "storage/feedback", "ledgers", "telemetry", "connectors", "config"];
const REQUIRED_TOOLS = ["memory_put", "memory_recall"];
const HANDSHAKE_TIMEOUT_MS = 60000;
const INSTALL_HINT = "run: bash scripts/install.sh --core";

function parseArgs(argv) {
  const opts = { root: DEFAULT_ROOT, dataRoot: "", nodeFloor: "22.18.0" };
  const keys = { "--root": "root", "--data-root": "dataRoot", "--node-floor": "nodeFloor" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write("usage: doctor.mjs [--root <checkout>] [--data-root <dir>] [--node-floor <x.y.z>]\n"
        + "  the data root is --data-root, else MEMORY_ROOT when set, else the checkout\n");
      process.exit(0);
    }
    const key = keys[arg];
    const value = argv[i + 1];
    if (!key || value === undefined || value === "") {
      process.stderr.write("doctor: " + (key ? arg + " needs a value" : "unknown argument: " + arg) + "\n");
      process.exit(64);
    }
    opts[key] = value;
    i++;
  }
  opts.root = path.resolve(opts.root);
  // Data root: the flag, then MEMORY_ROOT (a split code/data install), then the checkout.
  const envRoot = process.env.MEMORY_ROOT || "";
  opts.dataRoot = path.resolve(opts.dataRoot || envRoot || opts.root);
  return opts;
}

let coreFailed = false;
function line(mark, text) { process.stdout.write(mark + " " + text + "\n"); }
function ok(text) { line("[ok]  ", text); }
function fail(text) { coreFailed = true; line("[FAIL]", text); }
function absent(text) { line("[--]  ", text); }

function versionParts(v) {
  return String(v).split(".").slice(0, 3).map(function (p) { const n = parseInt(p, 10); return Number.isFinite(n) ? n : 0; });
}
function versionAtLeast(found, floor) {
  const a = versionParts(found);
  const b = versionParts(floor);
  for (let i = 0; i < 3; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

// --- core checks -----------------------------------------------------------------

function checkNode(floor) {
  const found = process.versions.node;
  if (versionAtLeast(found, floor)) ok("node version: " + found + " (needs " + floor + " or newer)");
  else fail("node version: " + found + " is too old; Node.js " + floor + " or newer is required");
}

function checkDependencies(root) {
  const code = "await import('hnswlib-node'); await import('@modelcontextprotocol/sdk/server/index.js');";
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: path.join(root, "mcp"), env: process.env, encoding: "utf8", timeout: HANDSHAKE_TIMEOUT_MS,
  });
  if (r.status === 0) { ok("dependencies load: the vector index and MCP modules import"); return true; }
  const m = /ERR_[A-Z_]+/.exec(r.stderr || "");
  fail("dependencies load: modules in mcp/node_modules did not import" + (m ? " (" + m[0] + ")" : "") + "; " + INSTALL_HINT);
  return false;
}

// Start the server, exchange initialize / initialized / tools/list as
// newline-delimited JSON-RPC, then stop it. Resolves { tools } or { reason }.
function handshake(root, dataRoot) {
  return new Promise(function (resolve) {
    const childEnv = Object.assign({}, process.env);
    childEnv.MEMORY_ROOT = dataRoot;
    let child;
    try {
      child = spawn(process.execPath, [path.join(root, "mcp", "server.js")], { cwd: root, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({ reason: "the server could not be started (" + (err.code || "spawn error") + ")" });
      return;
    }
    let buffer = "";
    let result = null;
    let exited = false;
    let killTimer = null;
    const pending = new Map();
    let nextId = 1;

    function finish(value) {
      if (result) return;
      result = value;
      clearTimeout(timer);
      if (exited) { resolve(result); return; }
      try { child.stdin.end(); } catch (err) { /* already closed */ }
      killTimer = setTimeout(function () {
        try { child.kill("SIGTERM"); } catch (err) { /* already gone */ }
        killTimer = setTimeout(function () { try { child.kill("SIGKILL"); } catch (err) { /* already gone */ } }, 3000);
      }, 2000);
    }
    const timer = setTimeout(function () {
      finish({ reason: "no answer within " + HANDSHAKE_TIMEOUT_MS / 1000 + " seconds" });
    }, HANDSHAKE_TIMEOUT_MS);

    function rpc(method, params) {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: id, method: method, params: params }) + "\n");
      return new Promise(function (res) { pending.set(id, res); });
    }

    child.stdin.on("error", function () { /* the exit handler reports it */ });
    child.stderr.on("data", function () { /* server logs are not shown */ });
    child.stdout.on("data", function (chunk) {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const text = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        let msg = null;
        try { msg = JSON.parse(text); } catch (err) { continue; }
        if (msg && msg.id && pending.has(msg.id)) { const res = pending.get(msg.id); pending.delete(msg.id); res(msg); }
      }
    });
    child.on("error", function (err) {
      exited = true;
      finish({ reason: "the server could not be started (" + (err.code || "spawn error") + ")" });
      resolve(result);
    });
    child.on("exit", function (code, signal) {
      exited = true;
      clearTimeout(killTimer);
      finish({ reason: "the server exited early (" + (signal || "exit " + code) + ")" });
      resolve(result);
    });

    rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "install-doctor", version: "1" } })
      .then(function (init) {
        if (!init.result) { finish({ reason: "the server rejected initialize" }); return null; }
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
        return rpc("tools/list", {});
      })
      .then(function (listed) {
        if (!listed) return;
        const tools = listed.result && Array.isArray(listed.result.tools) ? listed.result.tools.map(function (t) { return t.name; }) : null;
        finish(tools ? { tools: tools } : { reason: "the server returned no tool list" });
      })
      .catch(function () { finish({ reason: "the server connection closed" }); });
  });
}

async function checkServer(root, dataRoot) {
  const r = await handshake(root, dataRoot);
  const see = "; run `node mcp/server.js` in the checkout to see its error output";
  if (!r.tools) { fail("server handshake: " + r.reason + see); return; }
  const missing = REQUIRED_TOOLS.filter(function (t) { return r.tools.indexOf(t) < 0; });
  if (missing.length) { fail("server handshake: the tool list lacks " + missing.join(", ")); return; }
  ok("server handshake: initialize and tools/list answered (" + r.tools.length + " tools)");
}

function checkWritable(dataRoot) {
  const bad = [];
  for (const rel of DATA_DIRS) {
    const probe = path.join(dataRoot, rel, ".doctor-write-test-" + process.pid);
    try {
      fs.writeFileSync(probe, "", { flag: "wx" });
      fs.unlinkSync(probe);
    } catch (err) {
      bad.push(rel + " (" + (err.code === "ENOENT" ? "missing" : "not writable") + ")");
    }
  }
  if (bad.length === 0) ok("data root writable: " + dataRoot);
  else fail("data root writable: " + dataRoot + " has " + bad.join(", ") + "; " + INSTALL_HINT);
}

// --- optional checks (never change the exit code) --------------------------------

function exists(p) { try { fs.statSync(p); return true; } catch (err) { return false; } }

function checkOptional(root, dataRoot) {
  const embedPy = path.join(root, "local-embedder", ".venv", "bin", "python3");
  if (exists(embedPy)) ok("optional: embedder Python environment present (local-embedder/.venv)");
  else absent("optional: embedder Python environment absent (install.sh --python)");

  const sttPy = path.join(root, ".venv-stt", "bin", "python");
  if (exists(sttPy)) ok("optional: speech-to-text Python environment present (.venv-stt)");
  else absent("optional: speech-to-text Python environment absent (install.sh --python, Apple Silicon only)");

  let plists = 0;
  try { plists = fs.readdirSync(path.join(root, "launchd", "rendered")).filter(function (n) { return n.endsWith(".plist"); }).length; } catch (err) { plists = 0; }
  if (plists) ok("optional: " + plists + " rendered service file(s) in launchd/rendered");
  else absent("optional: no rendered service files (install.sh --services)");

  const identity = path.join(dataRoot, "config", "operator-identity.json");
  if (!exists(identity)) {
    absent("optional: " + identity + " absent");
  } else {
    let same = false;
    try { same = fs.readFileSync(identity).equals(fs.readFileSync(path.join(root, "config", "operator-identity.example.json"))); } catch (err) { same = false; }
    if (same) absent("optional: " + identity + " is still the unedited example; replace its values with your own");
    else ok("optional: " + identity + " present and edited");
  }

  const secrets = path.join(dataRoot, "config", "secrets.env");
  let mode = null;
  try { mode = fs.statSync(secrets).mode & 0o777; } catch (err) { mode = null; }
  if (mode === null) absent("optional: no secrets file (the core needs none)");
  else if (mode & 0o077) absent("optional: " + secrets + " is readable by others (mode " + mode.toString(8) + "); run: chmod 600 on that file");
  else ok("optional: " + secrets + " present with private mode " + mode.toString(8));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  process.stdout.write("install check\n  checkout:  " + opts.root + "\n  data root: " + opts.dataRoot + "\n");
  checkNode(opts.nodeFloor);
  if (checkDependencies(opts.root)) await checkServer(opts.root, opts.dataRoot);
  else fail("server handshake: skipped because the dependencies did not load");
  checkWritable(opts.dataRoot);
  checkOptional(opts.root, opts.dataRoot);
  process.stdout.write(coreFailed ? "core: NOT usable\n" : "core: usable\n");
  process.exit(coreFailed ? 1 : 0);
}

main().catch(function (err) {
  process.stderr.write("doctor: unexpected failure (" + (err && err.code ? err.code : "error") + ")\n");
  process.stdout.write("core: NOT usable\n");
  process.exit(1);
});
