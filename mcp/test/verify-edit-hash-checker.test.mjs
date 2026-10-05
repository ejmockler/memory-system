// verify-edit-hash-checker.test.mjs
//
// Self-tests for B7 / verify-edit.mjs.
//
// T1: capture + modify + verify with --required-changes
//     → file reported as changed, exit 0
// T2: capture + DO NOT modify + verify with --required-changes
//     → file reported as "agent claimed but unchanged", exit 1
// T3: capture on absent file + create file + verify
//     → reported as CHANGED (absent -> present), exit 0
// T4: capture + delete + verify with --required-unchanged
//     → reported as CHANGED + CRITICAL "required to remain unchanged", exit 1
//
// HERMETIC: every test writes into a fresh mkdtempSync tree. Nothing under
// <checkout>/storage/ or memory.jsonl / recall.jsonl is
// touched.
//
// Run: node test/verify-edit-hash-checker.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../scripts/verify-edit.mjs",
);

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? "\n      " + detail : ""}`);
  }
}

function run(args) {
  const r = spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function freshDir(tag) {
  return mkdtempSync(join(tmpdir(), `verify-edit-${tag}-`));
}

// --- T1: required-changes file IS modified → exit 0 ---
{
  const dir = freshDir("t1");
  const target = join(dir, "subject.txt");
  const manifest = join(dir, "manifest.json");
  writeFileSync(target, "version-1");

  const cap = run(["capture", `--files=${target}`, `--output=${manifest}`]);
  check("T1 capture exit 0", cap.code === 0, `stderr=${cap.stderr}`);
  check("T1 manifest written", existsSync(manifest));

  // Wait 5ms then write different bytes to bump mtime + sha256.
  const sleep = Atomics.wait
    ? () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    : () => {};
  sleep();
  writeFileSync(target, "version-2-different-bytes");

  const ver = run([
    "verify",
    `--manifest=${manifest}`,
    `--required-changes=${target}`,
  ]);
  check("T1 verify exit 0 (file did change)", ver.code === 0, `stdout=${ver.stdout}\nstderr=${ver.stderr}`);
  check(
    "T1 stdout reports CHANGED",
    ver.stdout.includes("CHANGED"),
    `stdout=${ver.stdout}`,
  );
}

// --- T2: required-changes file NOT modified → exit 1 ---
{
  const dir = freshDir("t2");
  const target = join(dir, "subject.txt");
  const manifest = join(dir, "manifest.json");
  writeFileSync(target, "stable-content");

  const cap = run(["capture", `--files=${target}`, `--output=${manifest}`]);
  check("T2 capture exit 0", cap.code === 0);

  // Deliberately do NOT touch the file. This is the R32-watermark-agent
  // pattern: claim to edit, edit nothing.
  const ver = run([
    "verify",
    `--manifest=${manifest}`,
    `--required-changes=${target}`,
  ]);
  check(
    "T2 verify exit 1 (agent claimed but file unchanged)",
    ver.code === 1,
    `code=${ver.code} stdout=${ver.stdout}`,
  );
  check(
    "T2 stdout names the CRITICAL finding",
    ver.stdout.includes("CRITICAL") &&
      ver.stdout.includes("mtime+size+sha256 unchanged"),
    `stdout=${ver.stdout}`,
  );
}

// --- T3: capture on absent file + create it + verify → exit 0, CHANGED ---
{
  const dir = freshDir("t3");
  const target = join(dir, "will-be-created.txt");
  const manifest = join(dir, "manifest.json");
  // target does NOT exist yet.

  const cap = run(["capture", `--files=${target}`, `--output=${manifest}`]);
  check("T3 capture exit 0 on absent file", cap.code === 0);

  // Now create the file.
  writeFileSync(target, "brand-new");

  const ver = run([
    "verify",
    `--manifest=${manifest}`,
    `--required-changes=${target}`,
  ]);
  check(
    "T3 verify exit 0 (absent -> present counts as CHANGED)",
    ver.code === 0,
    `code=${ver.code} stdout=${ver.stdout}`,
  );
  check(
    "T3 stdout reports CHANGED",
    ver.stdout.includes("CHANGED"),
    `stdout=${ver.stdout}`,
  );
  check(
    "T3 stdout shows before-ABSENT",
    ver.stdout.includes("before: ABSENT"),
    `stdout=${ver.stdout}`,
  );
}

// --- T4: capture + delete + verify with --required-unchanged → exit 1 ---
{
  const dir = freshDir("t4");
  const target = join(dir, "should-not-be-deleted.txt");
  const manifest = join(dir, "manifest.json");
  writeFileSync(target, "fragile-content");

  const cap = run(["capture", `--files=${target}`, `--output=${manifest}`]);
  check("T4 capture exit 0", cap.code === 0);

  // Delete the file the gate said must remain.
  unlinkSync(target);

  const ver = run([
    "verify",
    `--manifest=${manifest}`,
    `--required-unchanged=${target}`,
  ]);
  check(
    "T4 verify exit 1 (file required unchanged was deleted)",
    ver.code === 1,
    `code=${ver.code} stdout=${ver.stdout}`,
  );
  check(
    "T4 stdout names the CRITICAL finding",
    ver.stdout.includes("CRITICAL") &&
      ver.stdout.includes("required to remain unchanged"),
    `stdout=${ver.stdout}`,
  );
  check(
    "T4 stdout shows after-ABSENT",
    ver.stdout.includes("after:  ABSENT"),
    `stdout=${ver.stdout}`,
  );
}

if (failures === 0) {
  console.log("verify-edit-hash-checker: ALL PASS");
  process.exit(0);
} else {
  console.error(`verify-edit-hash-checker: ${failures} FAIL`);
  process.exit(1);
}
