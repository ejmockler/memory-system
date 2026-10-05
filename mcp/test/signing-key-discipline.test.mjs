// Signing-key custody discipline tests (round-15, C-NEW-3).
//
// Purpose: lock down the three things the round-14 leak exposed.
//   1. initSigningKey() materialises the key file at mode 0600 with nlink == 1.
//   2. The project-root .gitignore exists and excludes the signing-key file
//      by name (the tripwire for a future `git init` here).
//   3. loadSigningKey() emits a CRITICAL stderr warning the first time it
//      runs when the key file lives inside a directory whose ancestor
//      contains a .git subdir (the materialization-in-working-tree class
//      of bug). The warning fires once per process — the second call is
//      silent.
//
// HERMETICITY (round-14 C-NEW-2 pattern, mandatory): set MEMORY_ROOT to a
// mkdtempSync path BEFORE dynamic-importing daemon-token.js, so config.js
// binds signingKeyPath() inside the tmpdir, NOT the live <checkout>.
// Static ESM imports are hoisted, so dynamic import() after env mutation
// is the only way to redirect the production singleton.
//
// Run: node test/signing-key-discipline.test.mjs
// Exits 0 on pass, non-zero on any failure.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ----------- Hermetic root setup -----------
const TEST_ROOT = mkdtempSync(join(tmpdir(), "memsys-signkey-test-"));
mkdirSync(join(TEST_ROOT, "policy"), { recursive: true });
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");

// Capture the production policy-dir mtime BEFORE any module import so we can
// assert nothing in this test writes to the live <checkout>/policy.
// The checkout root is derived from this file's location (never from
// MEMORY_ROOT, which is redirected to the temp tree above), so we just stat
// the checkout's own policy path defensively if it exists.
const CHECKOUT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROD_POLICY_DIR = join(CHECKOUT_ROOT, "policy");
const PROD_KEY_PATH = `${PROD_POLICY_DIR}/distillation-signing-key.json`;
const prodKeyMtimeBefore = existsSync(PROD_KEY_PATH)
  ? statSync(PROD_KEY_PATH).mtimeMs
  : null;

// Dynamic import AFTER env vars are set so config.js picks up the override.
const { initSigningKey, loadSigningKey, _resetWorkingTreeWarning } =
  await import("../lib/daemon-token.js");
const { signingKeyPath } = await import("../lib/config.js");

const KEY_PATH = signingKeyPath();
check(
  "hermetic: signingKeyPath() points inside the test root",
  KEY_PATH.startsWith(TEST_ROOT),
  `actual: ${KEY_PATH}`,
);

// ----------- Test 1: initSigningKey creates 0600 + nlink == 1 -----------
const { key: initKey } = initSigningKey({ path: KEY_PATH });
check(
  "initSigningKey: file exists after init",
  existsSync(KEY_PATH),
);
const initStat = lstatSync(KEY_PATH);
check(
  "initSigningKey: mode is 0600",
  (initStat.mode & 0o777) === 0o600,
  `mode=${(initStat.mode & 0o777).toString(8)}`,
);
check(
  "initSigningKey: nlink === 1",
  initStat.nlink === 1,
  `nlink=${initStat.nlink}`,
);
check(
  "initSigningKey: returned key is 32 bytes",
  Buffer.isBuffer(initKey) && initKey.length === 32,
);

// JSON shape sanity — re-load via loadSigningKey, confirm versions match.
const loaded = loadSigningKey({ path: KEY_PATH });
check(
  "loadSigningKey: version == 1",
  loaded.version === 1,
);
check(
  "loadSigningKey: key matches init",
  loaded.key.equals(initKey),
);

// ----------- Test 2: project-root .gitignore exists + excludes key -----------
// The .gitignore at <checkout>/.gitignore is a *real* file
// (not under MEMORY_ROOT override) — its job is to protect the literal
// production path if the dir ever becomes a git repo. We check it directly.
const PROJECT_GITIGNORE = join(CHECKOUT_ROOT, ".gitignore");
check(
  "gitignore: project-root .gitignore exists",
  existsSync(PROJECT_GITIGNORE),
  `expected at ${PROJECT_GITIGNORE}`,
);
if (existsSync(PROJECT_GITIGNORE)) {
  const gi = readFileSync(PROJECT_GITIGNORE, "utf8");
  check(
    "gitignore: excludes distillation-signing-key.json by name",
    gi.includes("distillation-signing-key.json"),
  );
  check(
    "gitignore: excludes consumed-nonces.jsonl",
    gi.includes("consumed-nonces.jsonl"),
  );
  check(
    "gitignore: excludes policy-events-*.jsonl",
    gi.includes("policy-events-*.jsonl"),
  );
}
// Defense in depth: policy/.gitignore should exist and catch-all.
const POLICY_GITIGNORE = join(CHECKOUT_ROOT, "policy", ".gitignore");
check(
  "gitignore: policy/.gitignore exists (defense in depth)",
  existsSync(POLICY_GITIGNORE),
);
if (existsSync(POLICY_GITIGNORE)) {
  const pgi = readFileSync(POLICY_GITIGNORE, "utf8");
  check(
    "gitignore: policy/.gitignore uses '*' catch-all",
    pgi.includes("*"),
  );
}

// ----------- Test 3: working-tree tripwire fires CRITICAL warning -----------
// Build a faux git working tree: TEST_ROOT/.git/ (we already created
// TEST_ROOT/policy/), and reset the one-time warning flag so the call we're
// about to make is the "first" call.
mkdirSync(join(TEST_ROOT, ".git"), { recursive: true });
_resetWorkingTreeWarning();

// Capture stderr by monkey-patching process.stderr.write for the duration of
// the call. We restore the original write before any assertion to avoid
// swallowing later FAIL lines.
const stderrChunks = [];
const realStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  try {
    stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  } catch {
    // ignore
  }
  return realStderrWrite(chunk, ...rest);
};
try {
  loadSigningKey({ path: KEY_PATH });
} finally {
  process.stderr.write = realStderrWrite;
}
const stderrText = stderrChunks.join("");
check(
  "tripwire: first call inside working tree emits CRITICAL on stderr",
  stderrText.includes("CRITICAL"),
  `stderr: ${stderrText.slice(0, 200)}`,
);
check(
  "tripwire: warning names the signing-key path",
  stderrText.includes(KEY_PATH),
);
check(
  "tripwire: warning names the .git marker location",
  stderrText.includes(join(TEST_ROOT, ".git")),
);

// Second call should be SILENT (one-shot guard).
const stderrChunks2 = [];
const realStderrWrite2 = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  try {
    stderrChunks2.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  } catch {
    // ignore
  }
  return realStderrWrite2(chunk, ...rest);
};
try {
  loadSigningKey({ path: KEY_PATH });
} finally {
  process.stderr.write = realStderrWrite2;
}
const stderrText2 = stderrChunks2.join("");
check(
  "tripwire: second call is silent (one-shot guard)",
  !stderrText2.includes("CRITICAL"),
  `stderr2: ${stderrText2.slice(0, 200)}`,
);

// ----------- Production-file mtime invariant (round-14 C-NEW-2) -----------
// This test must not touch the live <checkout>/policy/.
const prodKeyMtimeAfter = existsSync(PROD_KEY_PATH)
  ? statSync(PROD_KEY_PATH).mtimeMs
  : null;
check(
  "production safety: real signing key (if any) mtime unchanged",
  prodKeyMtimeBefore === prodKeyMtimeAfter,
  `before=${prodKeyMtimeBefore} after=${prodKeyMtimeAfter}`,
);

// ----------- Cleanup -----------
try {
  rmSync(TEST_ROOT, { recursive: true, force: true });
} catch {
  // best-effort
}

if (failures > 0) {
  console.error(`\nFAILED: ${failures} signing-key-discipline assertion(s)`);
  process.exit(1);
}
console.log("\nAll signing-key-discipline assertions passed.");
