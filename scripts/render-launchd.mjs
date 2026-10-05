#!/usr/bin/env node
// render-launchd.mjs: render launchd/*.plist.template into loadable plists.
//
//   node scripts/render-launchd.mjs --root <abs> --home <abs> --out <dir>
//        [--node <path>] [--only a,b] [--install]
//
//   --root     absolute path of the checkout the services run from
//   --home     absolute path of the home directory of the account that runs them
//   --out      directory the rendered plists are written to (created if missing)
//   --node     node binary the services pin (default: the node running this script)
//   --only     comma-separated short service names, e.g. watermark,queryd
//   --install  ALSO copy the rendered plists into <home>/Library/LaunchAgents and
//              bootstrap each one with launchctl. This flag is the only code path
//              that touches that directory or spawns launchctl.
//
// Templates are located relative to this file (../launchd), never the working
// directory. Rendering fails loudly, before anything is written, if a
// placeholder survives substitution. Node builtins only; the script reads no
// environment variable, so every machine-specific value arrives as a flag.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const LABEL_PREFIX = "com.user.memory-system.";
const TEMPLATE_RE = /^com\.user\.memory-system\.(.+)\.plist\.template$/;
const PLACEHOLDER_RE = /__[A-Z_]+__/;
const TEMPLATE_DIR = fileURLToPath(new URL("../launchd/", import.meta.url));

function fail(message, code = 1) {
  process.stderr.write(`render-launchd: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { install: false };
  const valued = new Set(["--root", "--home", "--out", "--node", "--only"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--install") { opts.install = true; continue; }
    if (arg === "--help" || arg === "-h") { opts.help = true; continue; }
    if (!valued.has(arg)) fail(`unknown argument: ${arg}`, 64);
    const value = argv[++i];
    if (value === undefined || value === "") fail(`${arg} needs a value`, 64);
    opts[arg.slice(2)] = value;
  }
  return opts;
}

const xmlEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function listTemplates() {
  let names;
  try { names = fs.readdirSync(TEMPLATE_DIR); } catch (err) { fail(`cannot read template directory ${TEMPLATE_DIR}: ${err.code || err.message}`); }
  const found = new Map();
  for (const name of names.sort()) {
    const m = TEMPLATE_RE.exec(name);
    if (m) found.set(m[1], name);
  }
  if (found.size === 0) fail(`no templates found in ${TEMPLATE_DIR}`);
  return found;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write("usage: render-launchd.mjs --root <abs> --home <abs> --out <dir> [--node <path>] [--only a,b] [--install]\n");
    return;
  }
  for (const flag of ["root", "home", "out"]) if (!opts[flag]) fail(`--${flag} is required`, 64);
  for (const flag of ["root", "home"]) if (!path.isAbsolute(opts[flag])) fail(`--${flag} must be an absolute path, got: ${opts[flag]}`, 64);

  const root = path.normalize(opts.root).replace(/(.)\/+$/, "$1");
  const home = path.normalize(opts.home).replace(/(.)\/+$/, "$1");
  const outDir = path.resolve(opts.out);
  const values = {
    __MEMORY_ROOT__: root,
    __HOME__: home,
    __NODE__: opts.node || process.execPath,
    __PYTHON_EMBED__: path.join(root, "local-embedder", ".venv", "bin", "python3"),
    __PYTHON_STT__: path.join(root, ".venv-stt", "bin", "python"),
  };

  const templates = listTemplates();
  let selected = [...templates.keys()];
  if (opts.only !== undefined) {
    selected = [...new Set(opts.only.split(",").map((s) => s.trim()).filter(Boolean))];
    if (selected.length === 0) fail("--only needs at least one service name", 64);
    const unknown = selected.filter((s) => !templates.has(s));
    if (unknown.length) fail(`unknown service name in --only: ${unknown.join(", ")} (known: ${[...templates.keys()].join(", ")})`, 64);
  }

  // Render everything in memory first so a bad template leaves --out untouched.
  const rendered = [];
  for (const service of selected) {
    const file = templates.get(service);
    let text = fs.readFileSync(path.join(TEMPLATE_DIR, file), "utf8");
    for (const [token, value] of Object.entries(values)) text = text.split(token).join(xmlEscape(value));
    const survivor = PLACEHOLDER_RE.exec(text);
    if (survivor) fail(`unreplaced placeholder ${survivor[0]} in launchd/${file}`);
    rendered.push({ name: `${LABEL_PREFIX}${service}.plist`, text });
  }

  fs.mkdirSync(outDir, { recursive: true });
  for (const { name, text } of rendered) {
    const dest = path.join(outDir, name);
    fs.writeFileSync(dest, text, { mode: 0o644 });
    fs.chmodSync(dest, 0o644);
  }
  process.stdout.write(`rendered ${rendered.length} plist(s) into ${outDir}\n`);

  if (opts.install) install(rendered.map((r) => r.name), outDir, home);
}

// Reached only under the explicit --install flag.
function install(names, outDir, home) {
  // os.homedir() follows $HOME, so compare with the account's real home from the user database.
  if (path.resolve(home) !== path.resolve(os.userInfo().homedir)) {
    fail(`--install refused: --home (${home}) is not the home directory of the current account`);
  }
  const agentsDir = path.join(home, "Library", "LaunchAgents");
  const domain = `gui/${process.getuid()}`;
  fs.mkdirSync(agentsDir, { recursive: true });
  let failed = 0;
  for (const name of names) {
    const dest = path.join(agentsDir, name);
    fs.copyFileSync(path.join(outDir, name), dest);
    fs.chmodSync(dest, 0o644);
    const r = spawnSync("/bin/launchctl", ["bootstrap", domain, dest], { encoding: "utf8" });
    if (r.status === 0) {
      process.stdout.write(`installed ${name}\n`);
    } else {
      failed++;
      const why = ((r.stderr || "") + (r.error ? r.error.message : "")).trim().split("\n").pop();
      process.stderr.write(`render-launchd: launchctl bootstrap failed for ${name} (exit ${r.status}): ${why}\n`);
    }
  }
  if (failed) process.exit(1);
}

main();
