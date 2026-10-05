// connectors-list-live.test.mjs — Phase 2b integration: memory_connectors_list
// must enumerate the four shipped connectors (imessage, screentime, git-log,
// github-events) once each writes its connectors/<source>/state.json.
//
// This test simulates the *post-first-poll* state for every connector by
// hand-crafting connectors/<source>/state.json files. It exercises the live
// MCP tool handler (lib/tools/connectors-list.js → listInstalledConnectors)
// end-to-end through the same envelope shape `dispatch` produces. No
// upstream sources are read (no chat.db, no knowledgeC.db, no `gh` shell).
//
// HERMETICITY: TEST_ROOT under mkdtempSync, env vars set BEFORE the first
// dynamic import of the tool / connector modules. The live install's
// connectors/* is NOT touched (the four real
// connectors have not been activated; their state files do not exist yet —
// activation is operator-gated behind FDA per kb/operations.md § Phase 2b
// activation procedure).

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Hermetic root — bind BEFORE first dynamic import.
// ---------------------------------------------------------------------------
const TEST_ROOT = mkdtempSync(join(tmpdir(), "connectors-list-live-test-"));
mkdirSync(join(TEST_ROOT, "policy"), { recursive: true });
mkdirSync(join(TEST_ROOT, "ledgers"), { recursive: true });
mkdirSync(join(TEST_ROOT, "storage", "sources"), { recursive: true });
mkdirSync(join(TEST_ROOT, "connectors"), { recursive: true });
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
process.env.CONNECTORS_BASE_DIR = join(TEST_ROOT, "connectors");
// W9: this suite asserts every shipped connector reports status='ok' from a
// fresh cursor write. Disable captured_only so screentime is treated as a
// normal cascade source. The production captured_only surfacing (mode +
// status='captured_only') is exercised in the validation.js CAPS path.
process.env.MEMORY_WATERMARK_CAPTURED_ONLY_OVERRIDE = "";
process.on("exit", () => {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
});

// Production-safety pre-snapshot.
const PROD_CONNECTORS_DIR = join(homedir(), "memory-system", "connectors");
let prodEntriesBefore = null;
try {
  prodEntriesBefore = readdirSync(PROD_CONNECTORS_DIR).sort();
} catch {
  prodEntriesBefore = [];
}

// ---------------------------------------------------------------------------
// Dynamic imports (post-env-binding).
// ---------------------------------------------------------------------------
const { TOOL } = await import("../lib/tools/connectors-list.js");
const { connectorsDir } = await import("../lib/config.js");

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------
let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Simulate the four Phase 2b connectors' first-poll cursor writes. Each
// state.json mirrors what ConnectorBase.writeCursor would emit on the FIRST
// successful poll: a fresh advance, zero errors, status implicitly "ok".
// ---------------------------------------------------------------------------
const NOW = new Date().toISOString();
const FOUR = [
  {
    source: "imessage",
    state: {
      cursor: 12345,                          // max message.ROWID seen
      last_appended_ts: NOW,
      last_appended_id: "ulid_FAKE_IMSG_001",
      last_cursor_advance_ts: NOW,
      error_count: 0,
    },
  },
  {
    source: "screentime",
    state: {
      cursor: 67890,                          // max ZOBJECT.Z_PK
      last_appended_ts: NOW,
      last_appended_id: "ulid_FAKE_ST_001",
      last_cursor_advance_ts: NOW,
      error_count: 0,
    },
  },
  {
    source: "git-log",
    state: {
      cursor: "abc1234def5678",               // last commit SHA per repo (string form ok)
      last_appended_ts: NOW,
      last_appended_id: "ulid_FAKE_GIT_001",
      last_cursor_advance_ts: NOW,
      error_count: 0,
    },
  },
  {
    source: "github-events",
    state: {
      cursor: "etag-W/\"deadbeef\"",           // ETag returned by gh api
      last_appended_ts: NOW,
      last_appended_id: "ulid_FAKE_GH_001",
      last_cursor_advance_ts: NOW,
      error_count: 0,
    },
  },
];

const dir = connectorsDir();
for (const { source, state } of FOUR) {
  const subdir = join(dir, source);
  mkdirSync(subdir, { recursive: true, mode: 0o700 });
  writeFileSync(join(subdir, "state.json"), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Test: invoke the live tool handler with empty args.
// ---------------------------------------------------------------------------
console.log("\n--- memory_connectors_list returns all four Phase 2b connectors ---");
const env = await TOOL.handler({});

check("envelope ok=true", env?.ok === true, JSON.stringify(env));
check("envelope.error is null", env?.error === null);
check("meta.tool is memory_connectors_list", env?.meta?.tool === "memory_connectors_list");
check("data.connectors is an array", Array.isArray(env?.data?.connectors));

const list = env.data.connectors;
check("exactly 4 connectors listed", list.length === 4, `got ${list.length}: ${JSON.stringify(list.map((c) => c.source))}`);

// Deterministic sort by source per listInstalledConnectors contract.
const sources = list.map((c) => c.source);
const expectedSources = ["git-log", "github-events", "imessage", "screentime"];
check(
  "sources sorted ascending include all four",
  JSON.stringify(sources) === JSON.stringify(expectedSources),
  `got ${JSON.stringify(sources)}`,
);

// Each entry's shape per kb/agent-integration.md § Connectors — the shared base abstraction.
for (const entry of list) {
  check(`${entry.source}: status=ok`, entry.status === "ok", `status=${entry.status}`);
  check(
    `${entry.source}: last_appended_ts surfaced`,
    typeof entry.last_appended_ts === "string" && entry.last_appended_ts === NOW,
    `got ${entry.last_appended_ts}`,
  );
  check(
    `${entry.source}: last_cursor_advance_ts surfaced`,
    typeof entry.last_cursor_advance_ts === "string" && entry.last_cursor_advance_ts === NOW,
    `got ${entry.last_cursor_advance_ts}`,
  );
  // The MCP entries deliberately do NOT carry the source-native cursor field
  // (per kb/agent-integration.md § Connectors — the metadata is {source,
  // status, last_appended_ts, last_cursor_advance_ts}). Confirm the leak
  // surface stays closed: no `cursor` / `error_count` / `last_appended_id`
  // bleed-through.
  check(
    `${entry.source}: source-native cursor not leaked`,
    entry.cursor === undefined && entry.error_count === undefined && entry.last_appended_id === undefined,
    `entry=${JSON.stringify(entry)}`,
  );
}

// ---------------------------------------------------------------------------
// F-NEW-W3-R42-HOSTNAME-LAZY-IMPORT-RACE — integration test for the
// WARN surface. Trigger emitHostnameDerivedWarning over the threshold
// (5%) and assert health.level === "WARN" with a warnings[] entry that
// describes the identity_hostname_dominance_warn condition. Also asserts
// the FIRST trigger in a fresh process actually populates the warning
// state (i.e. the eager telemetry import closes the lazy-load race).
// ---------------------------------------------------------------------------
console.log(
  "\n--- F-NEW-W3-R42-HOSTNAME-LAZY-IMPORT-RACE: emitHostnameDerivedWarning surfaces WARN level + warnings[] entry ---"
);
const {
  emitHostnameDerivedWarning,
  resetHostnameWarnState,
} = await import("../lib/identity/operator-identity.js");

// Reset any prior state so this test is isolated even if other code in
// the same test process previously emitted a warning.
resetHostnameWarnState();

// Trigger threshold-exceeding warn: 10/10 = 100% hostname-derived, far
// over the 5% threshold. Two-arg form to be explicit about counts.
const warnResult = emitHostnameDerivedWarning(10, 10, {
  source: "git-log-local",
});
check(
  "first-call emitHostnameDerivedWarning triggers",
  warnResult.triggered === true && warnResult.reason === "threshold_exceeded",
  JSON.stringify(warnResult),
);

// Invoke the tool a second time after the warn and assert the WARN
// surface is populated. The warn state is process-local; the eager
// telemetry import (see operator-identity.js header) means the FIRST
// call already incremented the recordDrop counter, so a second tool
// call should observe both the warning entry AND the WARN health level.
const env2 = await TOOL.handler({});
check(
  "post-warn envelope ok=true",
  env2?.ok === true,
  JSON.stringify(env2 && env2.error),
);
check(
  "post-warn health.level === WARN",
  env2?.data?.health?.level === "WARN",
  `got level=${env2?.data?.health?.level}`,
);
const warnEntries = Array.isArray(env2?.data?.health?.warnings)
  ? env2.data.health.warnings
  : [];
check(
  "post-warn health.warnings[] has identity_hostname_dominance_warn entry",
  warnEntries.some(
    (w) =>
      w &&
      w.kind === "identity_hostname_dominance_warn" &&
      w.source === "git-log-local" &&
      typeof w.fraction === "number" &&
      w.fraction > 0.05,
  ),
  JSON.stringify(warnEntries),
);

// ---------------------------------------------------------------------------
// Production-safety: confirm we did not touch the real connectors/ dir.
// ---------------------------------------------------------------------------
let prodEntriesAfter = null;
try { prodEntriesAfter = readdirSync(PROD_CONNECTORS_DIR).sort(); } catch { prodEntriesAfter = []; }
check(
  "PROD-SAFETY production connectors/ contents unchanged",
  JSON.stringify(prodEntriesBefore) === JSON.stringify(prodEntriesAfter),
  `before=${JSON.stringify(prodEntriesBefore)} after=${JSON.stringify(prodEntriesAfter)}`,
);

// Clean up state for any subsequent tests that may import this module.
resetHostnameWarnState();

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log(`\nAll connectors-list-live assertions passed.`);
