// memory.jsonl durability — round-15 H3 (memory-jsonl-fsync).
//
// Validates the three durability invariants for distill-promote-fact's
// appendFactRow():
//
//   1. The appended row is fully written AND carries the spec-mandated
//      `checksum` field (blake2b512 trunc-16 of canonical JSON, sans-checksum).
//   2. The ledger file mode is 0600 after first creation — privileged data,
//      operator-only.
//   3. Both the file descriptor AND the parent directory are fsync'd after
//      every append. Without the dir-fsync, even careful file-fsync can lose
//      the new file's directory entry in a power-cut.
//
// HERMETICITY: env vars set BEFORE the dynamic import of the tool module, per
// round-14 C-NEW-2 discipline. All disk writes redirect into mkdtempSync.
// Production memory.jsonl mtime + size MUST NOT change across this run.
//
// F-NEW-W4-VERIFY-MEMORY-DISTILL-FALSE-OK: tests 1–3 exercise the durability
// pipeline (file-fsync + dir-fsync + checksum field) and therefore opt out
// of the R25 salience cascade via MEMORY_SALIENCE_BYPASS=1. The cascade is
// the right policy gate for production but actively defeats the durability
// invariants under test here — the chat-claude-code Stage-0 module would
// route the synthetic source rows to DROP empty_turn (because the handler
// does not forward firstSourceRow.raw_content onto the salience event), so
// no fact row would ever be appended and readFileSync(LEDGER_PATH) would
// ENOENT. Test 4 (the new dropped=true envelope assertion) deliberately
// does NOT set the bypass: it is the test that proves the envelope shape
// the handler now surfaces on the DROP path.
//
// Run: node test/memory-jsonl-durability.test.mjs
// Exits 0 on pass, non-zero on failure.

import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Hermetic root setup — MUST happen before any dynamic import.
// ---------------------------------------------------------------------------
const TEST_ROOT = mkdtempSync(join(tmpdir(), "memsys-durability-test-"));
mkdirSync(join(TEST_ROOT, "policy"), { recursive: true });
mkdirSync(join(TEST_ROOT, "ledgers"), { recursive: true });
mkdirSync(join(TEST_ROOT, "storage", "sources"), { recursive: true });
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
// Opt out of the R25 salience cascade for the durability tests below; test 4
// re-enables the cascade by unsetting this before its handler call.
process.env.MEMORY_SALIENCE_BYPASS = "1";
process.on("exit", () => {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
});

// Production-safety pre-snapshot: capture mtime+size of the real memory.jsonl
// (if it exists) so we can re-stat at exit and fail loudly if the test
// accidentally wrote to production.
const PROD_LEDGER = join(homedir(), "memory-system", "ledgers", "memory.jsonl");
let prodBefore = null;
try { const st = statSync(PROD_LEDGER); prodBefore = { mtimeMs: st.mtimeMs, size: st.size }; } catch {}

// ---------------------------------------------------------------------------
// Dynamic imports — paths now bind inside TEST_ROOT.
// ---------------------------------------------------------------------------
const { TOOL } = await import("../lib/tools/distill-promote-fact.js");
const { mintToken, initSigningKey, loadSigningKey } = await import("../lib/daemon-token.js");
const { canonicalJson, canonicalJsonSha256Hex } = await import("../lib/validation.js");
const { memoryLedgerPath, signingKeyPath } = await import("../lib/config.js");

const LEDGER_PATH = memoryLedgerPath();

// ---------------------------------------------------------------------------
// Test harness
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

// Seed the source-ledger row so BOTH the consent walk AND the chat-claude-code
// Stage-0 cascade pass. The chat-claude-code Stage-0 module reads
// raw_content.{user_text, assistant_text}; with both empty/absent the cascade
// returns DROP empty_turn and no fact row is appended. Substantive multi-
// sentence text on both sides routes the row to PASS so the durability
// invariants under test (file write, fsync, dir-fsync) actually exercise.
function seedSourceRow(source, sourceMsgId) {
  const path = join(TEST_ROOT, "storage", "sources", `${source}.jsonl`);
  const row = {
    id: sourceMsgId,
    source_msg_id: sourceMsgId,
    ts: "2026-05-31T00:00:00Z",
    raw_content: {
      conversation_id: "conv-test",
      user_text:
        "Durability harness probe: please confirm the ledger append-and-fsync path is operating end-to-end. We need both data and directory metadata synced before the policy event fires so a crash here cannot leave a torn fact row.",
      assistant_text:
        "Confirmed. The fact-row append uses O_APPEND|O_CREAT|O_NOFOLLOW with mode 0600, fsyncs the file descriptor, then fsyncs the parent directory. The audit row is only written after both fsyncs succeed.",
    },
    source_policy: { consent_basis: "first_party" },
  };
  appendFileSync(path, JSON.stringify(row) + "\n", { mode: 0o600 });
}

// Seed a deliberately content-free source row (both user_text and
// assistant_text absent / blank). chat-claude-code Stage-0 will return
// DROP empty_turn — used by the dropped-envelope assertion below.
function seedContentFreeSourceRow(source, sourceMsgId) {
  const path = join(TEST_ROOT, "storage", "sources", `${source}.jsonl`);
  const row = {
    id: sourceMsgId,
    source_msg_id: sourceMsgId,
    ts: "2026-05-31T00:00:00Z",
    raw_content: { conversation_id: "conv-test", user_text: "", assistant_text: "" },
    source_policy: { consent_basis: "first_party" },
  };
  appendFileSync(path, JSON.stringify(row) + "\n", { mode: 0o600 });
}

// Build a complete privileged-call arg envelope and a matching signed token.
// initSigningKey is O_CREAT|O_EXCL — non-idempotent. After the first call
// the file exists; subsequent calls must loadSigningKey instead.
async function buildArgsAndToken(content, source, sourceMsgId) {
  let key;
  try {
    key = initSigningKey().key;
  } catch (e) {
    if (e && e.code === "EEXIST") {
      key = loadSigningKey().key;
    } else {
      throw e;
    }
  }
  const source_refs = [{ source, source_msg_id: sourceMsgId }];
  const contentHash = createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
  const sourceRefsHash = canonicalJsonSha256Hex(source_refs);
  const bindingObject = { content_hash: contentHash, source_refs_hash: sourceRefsHash };
  const bindingHash = canonicalJsonSha256Hex(bindingObject);
  const minted = mintToken(bindingHash, "memory_distill_promote_fact", key, {});
  return {
    args: {
      source_refs,
      content,
      derived_from: [],
      provenance: {
        agent_id: "test-agent",
        conversation_id: "conv-test",
        confidence: "medium",
      },
      confirmation_token: minted.token,
    },
  };
}

// Recompute the spec-frozen checksum for round-trip verification.
function expectedChecksum(rowWithoutChecksum) {
  const canonical = canonicalJson(rowWithoutChecksum);
  return createHash("blake2b512").update(Buffer.from(canonical, "utf8")).digest().subarray(0, 16).toString("hex");
}

// =========================================================================
// Test 1: appendFactRow writes a complete row + checksum field.
// =========================================================================
{
  const SOURCE = "chat-claude-code";
  const SOURCE_MSG_ID = "msg_test1_aaaa";
  seedSourceRow(SOURCE, SOURCE_MSG_ID);
  const content = "test-1: first fact row content";
  const { args } = await buildArgsAndToken(content, SOURCE, SOURCE_MSG_ID);
  const envelope = await TOOL.handler(args);
  check("test1: handler envelope.ok === true", envelope && envelope.ok === true,
    `envelope=${JSON.stringify(envelope)}`);
  // The file must exist and contain exactly one line.
  const raw = readFileSync(LEDGER_PATH, "utf8");
  const lines = raw.split("\n").filter((l) => l !== "");
  check("test1: ledger has exactly one row", lines.length === 1, `lines=${lines.length}`);
  let parsed;
  try { parsed = JSON.parse(lines[0]); } catch (e) { parsed = null; }
  check("test1: row is valid JSON", parsed != null);
  check("test1: row.content matches", parsed && parsed.content === content);
  check("test1: row has checksum field", parsed && typeof parsed.checksum === "string");
  check("test1: row.checksum is 32 hex chars", parsed && /^[0-9a-f]{32}$/.test(parsed.checksum));
  // Verify the checksum byte-for-byte against the spec derivation.
  if (parsed && parsed.checksum) {
    const { checksum, ...withoutChecksum } = parsed;
    const expected = expectedChecksum(withoutChecksum);
    check("test1: row.checksum matches blake2b512-trunc16(canonical_json(row-sans-checksum))",
      checksum === expected, `got=${checksum} expected=${expected}`);
  }
  check("test1: row.kind === 'fact'", parsed && parsed.kind === "fact");
  check("test1: row.source_refs is array of length 1", parsed && Array.isArray(parsed.source_refs) && parsed.source_refs.length === 1);
  check("test1: row.source_refs[0].consent_basis === 'first_party'",
    parsed && parsed.source_refs[0] && parsed.source_refs[0].consent_basis === "first_party");
}

// =========================================================================
// Test 2: file mode is 0600 after first creation.
// =========================================================================
{
  const st = statSync(LEDGER_PATH);
  const mode = st.mode & 0o777;
  check("test2: ledger file mode is 0600 after first creation",
    mode === 0o600, `mode=${mode.toString(8)}`);
}

// =========================================================================
// Test 3: confirm BOTH file-fsync and dir-fsync are called by spawning a
// child Node process with a `--require` shim that hot-patches the node:fs
// CommonJS prototype BEFORE distill-promote-fact.js dynamic-imports. We
// cannot patch the ESM namespace object directly (it is read-only); the CJS
// require cache exposes the same underlying binding object and assignments
// to its members ARE visible to ESM live-bindings on most Node versions —
// but to remove that fragility we instead intercept via syscall-level
// telemetry: read the patched-child's JSON output recording fsync targets.
// =========================================================================
{
  const { spawnSync } = await import("node:child_process");
  const { writeFileSync, mkdirSync: mkdirSync2 } = await import("node:fs");
  const shimPath = join(TEST_ROOT, "fsync-shim.cjs");
  // CommonJS shim — runs BEFORE the user script via --require, monkey-patches
  // `require("fs")` exports so every openSync/fsyncSync in the test child is
  // observed. Because the ESM `node:fs` builtin reads its underlying impl
  // through the same internal binding the CJS require cache wraps, patching
  // the CJS members propagates to the ESM live-bindings inside
  // distill-promote-fact.js. Verified by the test below.
  const shim = `
const realFs = require("fs");
const realOpen = realFs.openSync;
const realFsync = realFs.fsyncSync;
const fdMeta = new Map();
const targets = [];
realFs.openSync = function patchedOpen(p, flags, mode) {
  const fd = realOpen.call(realFs, p, flags, mode);
  let kind = "file";
  try { if (realFs.fstatSync(fd).isDirectory()) kind = "dir"; } catch {}
  fdMeta.set(fd, { kind, path: String(p) });
  return fd;
};
realFs.fsyncSync = function patchedFsync(fd) {
  const m = fdMeta.get(fd);
  if (m) targets.push({ kind: m.kind, path: m.path });
  return realFsync.call(realFs, fd);
};
process.on("exit", () => {
  try {
    realFs.writeFileSync(process.env.FSYNC_RECORD_PATH, JSON.stringify(targets));
  } catch (e) {
    process.stderr.write("shim: failed to record: " + e.message + "\\n");
  }
});
`;
  writeFileSync(shimPath, shim);

  const recordPath = join(TEST_ROOT, "fsync-record.json");
  const driverPath = join(TEST_ROOT, "fsync-driver.mjs");
  // Driver — runs INSIDE the child, sets up its own hermetic root, mints a
  // token, calls the handler. Mirrors the outer harness but lives in a
  // separate process so the --require shim catches every fsync.
  const driverSource = `
import { mkdirSync, mkdtempSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const ROOT = mkdtempSync(join(tmpdir(), "memsys-fsync-driver-"));
mkdirSync(join(ROOT, "policy"), { recursive: true });
mkdirSync(join(ROOT, "ledgers"), { recursive: true });
mkdirSync(join(ROOT, "storage", "sources"), { recursive: true });
process.env.MEMORY_ROOT = ROOT;
process.env.POLICY_BASE_DIR = join(ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(ROOT, "ledgers");
// Opt out of R25 salience cascade — test 3 verifies fsync telemetry, which
// requires the fact-row append path to actually run.
process.env.MEMORY_SALIENCE_BYPASS = "1";

const { TOOL } = await import(${JSON.stringify(new URL("../lib/tools/distill-promote-fact.js", import.meta.url).href)});
const { mintToken, initSigningKey } = await import(${JSON.stringify(new URL("../lib/daemon-token.js", import.meta.url).href)});
const { canonicalJsonSha256Hex } = await import(${JSON.stringify(new URL("../lib/validation.js", import.meta.url).href)});

const SOURCE = "chat-claude-code";
const MSG = "msg_driver_xxxx";
// Substantive user_text + assistant_text so chat-claude-code Stage-0 PASSes
// (empty raw_content triggers DROP empty_turn and skips the fact-row append
// that test 3 needs to observe via fsync telemetry).
appendFileSync(join(ROOT, "storage", "sources", SOURCE + ".jsonl"), JSON.stringify({
  id: MSG, source_msg_id: MSG, ts: "2026-05-31T00:00:00Z",
  raw_content: {
    conversation_id: "c1",
    user_text: "Driver harness: confirm fsync telemetry observes both the file fsync and the parent directory fsync after a fact-row append.",
    assistant_text: "Acknowledged — appendFactRow performs writeSync, fsyncSync on the file descriptor, then opens the parent directory and fsyncs it. Both should appear in the shim's targets array.",
  },
  source_policy: { consent_basis: "first_party" },
}) + "\\n", { mode: 0o600 });

const { key } = initSigningKey();
const content = "driver fact row";
const sr = [{ source: SOURCE, source_msg_id: MSG }];
const ch = createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
const sh = canonicalJsonSha256Hex(sr);
const bh = canonicalJsonSha256Hex({ content_hash: ch, source_refs_hash: sh });
const minted = mintToken(bh, "memory_distill_promote_fact", key, {});
const env = await TOOL.handler({
  source_refs: sr,
  content,
  derived_from: [],
  provenance: { agent_id: "driver", conversation_id: "c1", confidence: "medium" },
  confirmation_token: minted.token,
});
if (!env || env.ok !== true) {
  process.stderr.write("driver: handler failed: " + JSON.stringify(env) + "\\n");
  process.exit(2);
}
// Record the ledger path so the parent can scope its fsync-target filter.
process.env.LEDGER_PATH_OUT = join(ROOT, "ledgers", "memory.jsonl");
import { writeFileSync as _wfs } from "node:fs";

_wfs(process.env.LEDGER_RECORD_PATH, JSON.stringify({
  ledgerPath: join(ROOT, "ledgers", "memory.jsonl"),
  ledgerDir:  join(ROOT, "ledgers"),
}));
`;
  writeFileSync(driverPath, driverSource);
  const ledgerRecordPath = join(TEST_ROOT, "ledger-record.json");
  const child = spawnSync(process.execPath, ["--require", shimPath, driverPath], {
    env: {
      ...process.env,
      FSYNC_RECORD_PATH: recordPath,
      LEDGER_RECORD_PATH: ledgerRecordPath,
    },
    encoding: "utf8",
  });
  check("test3: child driver exited 0",
    child.status === 0,
    `status=${child.status} stderr=${child.stderr}`);
  let targets = [];
  let ledgerInfo = null;
  try { targets = JSON.parse(readFileSync(recordPath, "utf8")); } catch {}
  try { ledgerInfo = JSON.parse(readFileSync(ledgerRecordPath, "utf8")); } catch {}
  check("test3: shim recorded at least one fsync target", targets.length >= 1,
    `targets.length=${targets.length}`);
  check("test3: ledger paths recorded", ledgerInfo != null);
  if (ledgerInfo) {
    const fileFsyncs = targets.filter(
      (t) => t.kind === "file" && t.path === ledgerInfo.ledgerPath,
    );
    const dirFsyncs = targets.filter(
      (t) => t.kind === "dir" && t.path === ledgerInfo.ledgerDir,
    );
    check("test3: appendFactRow fsync'd the ledger FILE",
      fileFsyncs.length >= 1,
      `file-fsync count=${fileFsyncs.length}; ledgerPath=${ledgerInfo.ledgerPath}`);
    check("test3: appendFactRow fsync'd the ledger DIRECTORY (parent)",
      dirFsyncs.length >= 1,
      `dir-fsync count=${dirFsyncs.length}; ledgerDir=${ledgerInfo.ledgerDir}; recent=${JSON.stringify(targets.slice(-10))}`);
  }
}

// =========================================================================
// Test 4: F-NEW-W4-VERIFY-MEMORY-DISTILL-FALSE-OK — when Stage-0 DROPs the
// row, the envelope MUST surface dropped=true + drop_reason so callers
// cannot conflate it with "promoted, here is your memory_event_id". Pre-fix
// the envelope was ok=true with memory_event_id=null and only the
// dedupe_action="salience_dropped" hint; legacy callers (and this very test
// file's test 1 prior to the F-NEW-W4 retrofit) read that as success.
// =========================================================================
{
  // Re-enable the R25 cascade for this test only. Restore the bypass
  // afterward so any tail-loaded code that re-reads process.env (none
  // currently) stays consistent with the surrounding harness.
  const _prevBypass = process.env.MEMORY_SALIENCE_BYPASS;
  delete process.env.MEMORY_SALIENCE_BYPASS;
  try {
    const SOURCE = "chat-claude-code";
    const SOURCE_MSG_ID = "msg_test4_dropped";
    seedContentFreeSourceRow(SOURCE, SOURCE_MSG_ID);
    // The content sent into the tool is non-empty (validation requires it),
    // but the source-ledger row's raw_content.{user_text,assistant_text} are
    // both empty. Stage-0 keys off the SOURCE row's raw_content (via
    // firstSourceRow in distill-promote-fact's salience cascade), so the
    // chat-claude-code module routes this to DROP empty_turn.
    const content = "test-4: tool content is non-empty but source row is content-free";
    const { args } = await buildArgsAndToken(content, SOURCE, SOURCE_MSG_ID);
    const envelope = await TOOL.handler(args);
    check("test4: handler envelope.ok === true on Stage-0 drop",
      envelope && envelope.ok === true,
      `envelope=${JSON.stringify(envelope)}`);
    check("test4: envelope.data.memory_event_id is null on drop",
      envelope && envelope.data && envelope.data.memory_event_id === null,
      `data=${JSON.stringify(envelope && envelope.data)}`);
    check("test4: envelope.data.dropped === true on drop",
      envelope && envelope.data && envelope.data.dropped === true,
      `dropped=${envelope && envelope.data && envelope.data.dropped}`);
    check("test4: envelope.data.drop_reason is a non-empty string",
      envelope && envelope.data && typeof envelope.data.drop_reason === "string"
        && envelope.data.drop_reason.length > 0,
      `drop_reason=${envelope && envelope.data && envelope.data.drop_reason}`);
    // Legacy dedupe_action contract preserved for backward compatibility.
    check("test4: envelope.data.dedupe_action === 'salience_dropped' (legacy)",
      envelope && envelope.data && envelope.data.dedupe_action === "salience_dropped",
      `dedupe_action=${envelope && envelope.data && envelope.data.dedupe_action}`);
  } finally {
    if (_prevBypass === undefined) {
      delete process.env.MEMORY_SALIENCE_BYPASS;
    } else {
      process.env.MEMORY_SALIENCE_BYPASS = _prevBypass;
    }
  }
}

// =========================================================================
// Production safety: re-stat the real memory.jsonl. mtime+size MUST be
// unchanged. If this check ever fails, the hermetic env-var redirect was
// broken (round-14 C-NEW-2 regression).
// =========================================================================
{
  let prodAfter = null;
  try { const st = statSync(PROD_LEDGER); prodAfter = { mtimeMs: st.mtimeMs, size: st.size }; } catch {}
  if (prodBefore == null && prodAfter == null) {
    check("production-safety: real memory.jsonl absent before AND after (acceptable)", true);
  } else if (prodBefore != null && prodAfter != null) {
    check("production-safety: real memory.jsonl mtime unchanged",
      prodBefore.mtimeMs === prodAfter.mtimeMs,
      `before=${prodBefore.mtimeMs} after=${prodAfter.mtimeMs}`);
    check("production-safety: real memory.jsonl size unchanged",
      prodBefore.size === prodAfter.size,
      `before=${prodBefore.size} after=${prodAfter.size}`);
  } else {
    failures += 1;
    console.error(`FAIL  production-safety: real memory.jsonl appeared/disappeared during test`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll memory-jsonl-durability assertions passed.");
