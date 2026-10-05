// remaining-stringcap-sites.test.mjs — s9-remaining-stringcap-sites.
//
// The last two whole-file ledger reads in the tree, both found by RESOLVING a
// readFileSync call's first argument back to the file it actually opens (not by
// matching identifier spellings — neither call site's first argument is
// "ledger-ish", which is why the static class guard at
// mcp/test/no-ledger-readfilesync.test.mjs cannot see either of them):
//
//   SITE A  scripts/backfill-from-sources.mjs  memLineCount() / memSample(n)
//           readFileSync(memoryLedgerPath(), "utf8")
//   SITE B  mcp/lib/tools/distill-promote-fact.js  loadSourceRow()
//           readFileSync(join(STORAGE_SOURCES_DIR, `${safeSource}.jsonl`), "utf8")
//
// MEASURED THIS SESSION (2026-08-12, node v24.15.0 on this machine):
//   require('buffer').constants.MAX_STRING_LENGTH   =   536,870,888 B
//   ledgers/memory.jsonl        (Site A's target)   = 3,069,078,394 B  (5.716x)
//   storage/sources/mail.jsonl  (Site B's largest)  =   349,643,964 B  (0.651x)
// Commands:
//   node -e "console.log(require('buffer').constants.MAX_STRING_LENGTH)"
//   stat -f "%z %N" ledgers/memory.jsonl storage/sources/mail.jsonl
//
// So Site A throws ERR_STRING_TOO_LONG on EVERY run today. Site B does NOT
// throw today — it is over-cap-vulnerable in the future and heap-expensive now.
// Measured this session, isolated probe, 22,877,780 B / 50,000-row fixture,
// 5 runs stable to 3 significant figures:
//   readFileSync + split("\n") + linear scan : heapUsed +43.2 MB  (1.890 B/B)
//   streamLedgerLines + Symbol early-exit    : heapUsed  +7.2 MB  (0.315 B/B)
// and end-to-end through TOOL.handler in T-B5 below, 52,855,512 B fixture:
//   pre-fix 1.488 B/B  vs  post-fix 0.149-0.468 B/B.
// Site B's assertions key on that ratio, not on a throw.
//
// HERMETIC. Every fixture is built under mkdtempSync. Site A's half runs in a
// SPAWNED CHILD (importing the script also pulls daemons/watermark.js at module
// scope) with every base-dir env override set both in the spawn env AND at the
// top of the generated child, and the child refuses to proceed unless the
// resolved memoryLedgerPath() is inside its temp dir. Nothing here reads or
// writes the live ledgers/, indices/, storage/ or connectors/*/state.json.
//
// Run: cd mcp && node --test test/remaining-stringcap-sites.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { constants as bufferConstants } from "node:buffer";

import { streamLedgerLines } from "../lib/synthesis/_ledger-stream.js";

const MAX_STRING_LENGTH = bufferConstants.MAX_STRING_LENGTH;
const THIS_FILE = fileURLToPath(import.meta.url);
const MCP_DIR = dirname(dirname(THIS_FILE));
const REPO_ROOT = dirname(MCP_DIR);

const BACKFILL_SCRIPT = join(REPO_ROOT, "scripts", "backfill-from-sources.mjs");
const CONFIG_MODULE = join(MCP_DIR, "lib", "config.js");

// ---------------------------------------------------------------------------
// Sparse over-cap fixture builder — copied from
// mcp/test/scripts-stringcap.test.mjs (function makeOverCapLedger). A
// 600,000,000-byte APPARENT ledger costs ~8 KiB of real disk because the span
// between the head write and the tail write is a sparse hole.
//
// The LEADING "\n" on the tail write is load-bearing. ftruncateSync leaves a
// 600 MB run of NUL bytes containing no newline; without that newline the tail
// rows join the NUL run into ONE over-long line, the streaming primitives
// abandon it at maxLineBytes (8 MiB default), and you get
// {totalLines:1, parsedLines:1, skipped:1} with only the head row — a vacuous
// fixture that would let a broken fix look green. With it you get the head rows
// AND the tail rows, and skipped:1 IS the NUL run. Every over-cap fixture below
// is shape-asserted (assertOverCapShape) so a future maxLineBytes change cannot
// silently hollow it out.
// ---------------------------------------------------------------------------
const APPARENT_BYTES = 600_000_000;

function makeOverCapLedger(dir, name, headRows, tailRows) {
  const p = join(dir, name);
  const fd = openSync(p, "w");
  writeSync(fd, headRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  ftruncateSync(fd, APPARENT_BYTES);
  writeSync(
    fd,
    "\n" + tailRows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    APPARENT_BYTES,
  );
  closeSync(fd);
  return p;
}

// Fixture-integrity probe. Asserts the file really is over the cap AND that the
// streaming primitive sees head+tail rows with the NUL run counted as skipped.
function assertOverCapShape(p, expectedRows, label) {
  const size = statSync(p).size;
  assert.ok(
    size > MAX_STRING_LENGTH,
    `${label}: fixture is ${size} B, not over the ${MAX_STRING_LENGTH} B cap`,
  );
  const counts = streamLedgerLines(p, () => {});
  assert.equal(
    counts.totalLines,
    expectedRows,
    `${label}: expected ${expectedRows} real rows, got ${counts.totalLines} — fixture is hollow`,
  );
  assert.equal(
    counts.parsedLines,
    expectedRows,
    `${label}: expected ${expectedRows} parseable rows, got ${counts.parsedLines}`,
  );
  assert.ok(
    counts.skipped >= 1,
    `${label}: skipped=${counts.skipped}, expected >= 1 — the 600 MB NUL run was NOT seen, ` +
      "so the head and tail are joined into one line and this fixture proves nothing",
  );
  assert.equal(counts.readError, null, `${label}: unexpected readError ${counts.readError}`);
  return counts;
}

// ===========================================================================
// SITE B setup — hermetic env BEFORE any dynamic import of config.js.
// ===========================================================================
const B_ROOT = mkdtempSync(join(tmpdir(), "memsys-s9-siteB-"));
const B_POLICY = join(B_ROOT, "policy");
const B_STORAGE = join(B_ROOT, "storage");
const B_SOURCES = join(B_STORAGE, "sources");
const B_LEDGERS = join(B_ROOT, "ledgers");
const B_DAEMONS = join(B_ROOT, "daemons");
const B_CONNECTORS = join(B_ROOT, "connectors");
const B_HOOKS = join(B_ROOT, "hooks");

for (const d of [B_POLICY, B_STORAGE, B_SOURCES, B_LEDGERS, B_DAEMONS, B_CONNECTORS, B_HOOKS]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}

process.env.MEMORY_ROOT = B_ROOT;
process.env.POLICY_BASE_DIR = B_POLICY;
process.env.STORAGE_BASE_DIR = B_STORAGE;
process.env.LEDGERS_BASE_DIR = B_LEDGERS;
process.env.DAEMONS_BASE_DIR = B_DAEMONS;
process.env.CONNECTORS_BASE_DIR = B_CONNECTORS;
process.env.HOOKS_BASE_DIR = B_HOOKS;
// gemini-client validates the key SHAPE at boot even though no assertion below
// ever reaches an embed call (every Site B case resolves in the consent walk,
// which runs before the embed). Junk value, never dialled.
if (!process.env.GEMINI_API_KEY) {
  process.env.GEMINI_API_KEY = "AIzaJUNK_test_not_used_xxxxxxxxxxxxxxxxx";
}

// Dynamic imports AFTER the env is set (module-load-time consts in config.js).
const configMod = await import("../lib/config.js");
const daemonTokenMod = await import("../lib/daemon-token.js");
const validationMod = await import("../lib/validation.js");
const promoteMod = await import("../lib/tools/distill-promote-fact.js");

// Hermeticity gate: never let a Site B case run against the live storage/.
assert.equal(
  configMod.STORAGE_DIR,
  B_STORAGE,
  `config.STORAGE_DIR resolved to ${configMod.STORAGE_DIR}, not the temp dir ${B_STORAGE} — ` +
    "refusing to drive the promote handler against a non-hermetic storage root",
);
assert.ok(
  configMod.sourceLedgerPath("probe").startsWith(B_SOURCES),
  `sourceLedgerPath() resolved outside ${B_SOURCES}`,
);

daemonTokenMod.initSigningKey();
const SIGNING_KEY = daemonTokenMod.loadSigningKey().key;

// Drive the REAL handler with a freshly minted confirmation_token (pattern:
// mcp/test/promote-time-embedding.test.mjs buildArgsAndToken + attribution-e2e).
// The handler RE-THROWS ToolError (dispatch marshals it into an envelope in
// production), so normalize thrown and returned failures to one {code,message}.
let promoteSeq = 0;
async function callPromote(source, sourceMsgId) {
  promoteSeq += 1;
  const content = `s9_remaining_stringcap_probe_${promoteSeq}_${source}_${sourceMsgId}`;
  const sourceRefs = [{ source, source_msg_id: sourceMsgId }];
  const contentHash = createHash("sha256")
    .update(Buffer.from(content, "utf8"))
    .digest("hex");
  const bindingHash = validationMod.canonicalJsonSha256Hex({
    content_hash: contentHash,
    source_refs_hash: validationMod.canonicalJsonSha256Hex(sourceRefs),
  });
  const minted = daemonTokenMod.mintToken(
    bindingHash,
    "memory_distill_promote_fact",
    SIGNING_KEY,
  );
  const args = {
    source_refs: sourceRefs,
    content,
    derived_from: [],
    provenance: {
      agent_id: "s9-remaining-stringcap",
      conversation_id: "conv_s9_remaining_stringcap",
      confidence: "medium",
    },
    confirmation_token: minted.token,
  };
  try {
    const env = await promoteMod.TOOL.handler(args);
    if (env && env.ok === false && env.error) {
      return { code: env.error.code, message: env.error.message, via: "envelope" };
    }
    return { code: "OK", message: null, via: "ok" };
  } catch (e) {
    return {
      code: e && e.code ? e.code : "THROWN",
      message: e && e.message ? e.message : String(e),
      via: "throw",
    };
  }
}

function sourceRow(msgId, extra) {
  return Object.assign(
    {
      id: msgId,
      ts: "2026-08-01T00:00:00.000Z",
      source_msg_id: msgId,
      raw_content: { user_text: `u ${msgId}`, assistant_text: `a ${msgId}` },
    },
    extra || {},
  );
}

function writeSourceLedger(source, body) {
  const p = join(B_SOURCES, `${source}.jsonl`);
  writeFileSync(p, body, { mode: 0o600 });
  return p;
}

// ===========================================================================
// SITE B — T-B1: over-cap source ledger, target row in the TAIL, no policy.
// CONSENT_BLOCKED proves the row was found PAST the 536,870,888-byte boundary.
// ===========================================================================
test("T-B1 over-cap source ledger: tail row without source_policy reaches CONSENT_BLOCKED", async () => {
  const SOURCE = "chat-s9-tail-nopolicy";
  const TARGET = "s9_tail_no_policy_msg";
  const head = [sourceRow("s9_head_a", { source_policy: { consent_basis: "first_party" } })];
  const tail = [
    sourceRow("s9_tail_filler", { source_policy: { consent_basis: "first_party" } }),
    sourceRow(TARGET), // deliberately NO source_policy
  ];
  const p = makeOverCapLedger(B_SOURCES, `${SOURCE}.jsonl`, head, tail);
  assertOverCapShape(p, 3, "T-B1");

  const res = await callPromote(SOURCE, TARGET);
  assert.equal(
    res.code,
    "CONSENT_BLOCKED",
    `expected CONSENT_BLOCKED (row found past the cap boundary); got ${res.code}: ${res.message}`,
  );
  assert.match(
    res.message,
    /source_policy missing on chat-s9-tail-nopolicy\/s9_tail_no_policy_msg; refusing to promote/,
    "the CONSENT_BLOCKED message must be the existing one, byte-exact",
  );
});

// ===========================================================================
// SITE B — T-B2: over-cap ledger, valid policy in tail, ABSENT source_msg_id.
// The full scan must complete and produce the plain NOT_FOUND message.
// ===========================================================================
test("T-B2 over-cap source ledger: absent source_msg_id yields the exact NOT_FOUND message", async () => {
  const SOURCE = "chat-s9-tail-policy";
  const ABSENT = "s9_absent_msg_id_xyz";
  const head = [sourceRow("s9_h1", { source_policy: { consent_basis: "first_party" } })];
  const tail = [
    sourceRow("s9_t1", { source_policy: { consent_basis: "first_party" } }),
    sourceRow("s9_t2", { source_policy: { consent_basis: "first_party" } }),
  ];
  const p = makeOverCapLedger(B_SOURCES, `${SOURCE}.jsonl`, head, tail);
  assertOverCapShape(p, 3, "T-B2");

  const res = await callPromote(SOURCE, ABSENT);
  assert.equal(
    res.code,
    "NOT_FOUND",
    `expected NOT_FOUND after a completed over-cap scan; got ${res.code}: ${res.message}`,
  );
  assert.equal(
    res.message,
    `source_msg_id ${ABSENT} not found in ${SOURCE}`,
    "the plain not-found message must be preserved byte-exactly",
  );
});

// ===========================================================================
// SITE B — T-B3: the four preserved exits, plus the ordering proof.
// ===========================================================================
test("T-B3a invalid source name → NOT_FOUND, before any I/O", async () => {
  const res = await callPromote("bad/name", "whatever");
  assert.equal(res.code, "NOT_FOUND", `got ${res.code}: ${res.message}`);
  assert.equal(res.message, 'source "bad/name" is not a recognized source-ledger name');
});

test("T-B3b missing source ledger → NOT_FOUND with the missing-ledger message", async () => {
  const SOURCE = "chat-s9-never-created";
  const res = await callPromote(SOURCE, "any_id");
  assert.equal(res.code, "NOT_FOUND", `got ${res.code}: ${res.message}`);
  assert.equal(
    res.message,
    `source_refs entry resolved to missing source ledger: ${SOURCE}`,
  );
});

test("T-B3c 0-byte source ledger → NOT_FOUND '(ledger empty)'", async () => {
  const SOURCE = "chat-s9-empty";
  writeSourceLedger(SOURCE, "");
  assert.equal(statSync(join(B_SOURCES, `${SOURCE}.jsonl`)).size, 0, "fixture must be 0 bytes");
  const res = await callPromote(SOURCE, "any_id");
  assert.equal(res.code, "NOT_FOUND", `got ${res.code}: ${res.message}`);
  assert.equal(res.message, `source_msg_id any_id not found in ${SOURCE} (ledger empty)`);
});

test("T-B3d newlines-only source ledger → plain NOT_FOUND, NOT '(ledger empty)'", async () => {
  // The old code keyed the "(ledger empty)" exit on `raw === ""`, i.e. on FILE
  // SIZE 0 — not on "zero parseable rows". A newlines-only file is size > 0 and
  // fell through to the plain message. Keying the new branch on totalLines === 0
  // would silently change this message; keying it on file size preserves it.
  const SOURCE = "chat-s9-newlines-only";
  writeSourceLedger(SOURCE, "\n\n\n");
  assert.equal(statSync(join(B_SOURCES, `${SOURCE}.jsonl`)).size, 3, "fixture must be 3 bytes");
  const res = await callPromote(SOURCE, "any_id");
  assert.equal(res.code, "NOT_FOUND", `got ${res.code}: ${res.message}`);
  assert.equal(
    res.message,
    `source_msg_id any_id not found in ${SOURCE}`,
    "a newlines-only ledger is NOT the '(ledger empty)' case",
  );
});

test("T-B3e populated ledger, no matching row → plain NOT_FOUND", async () => {
  const SOURCE = "chat-s9-nomatch";
  writeSourceLedger(
    SOURCE,
    [sourceRow("a"), sourceRow("b")].map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  const res = await callPromote(SOURCE, "c");
  assert.equal(res.code, "NOT_FOUND", `got ${res.code}: ${res.message}`);
  assert.equal(res.message, `source_msg_id c not found in ${SOURCE}`);
});

test("T-B3f unreadable-at-open (EACCES) 0-byte ledger → INTERNAL_ERROR, never '(ledger empty)'", async () => {
  // ORDERING PROOF. This file is size 0, so a not-found determination made
  // BEFORE the readError check would emit the "(ledger empty)" NOT_FOUND. The
  // streaming primitive never throws, so only an explicit counts.readError
  // check keeps an unreadable ledger from falsifying the consent gate.
  const SOURCE = "chat-s9-eacces";
  const p = writeSourceLedger(SOURCE, "");
  chmodSync(p, 0o000);
  try {
    const res = await callPromote(SOURCE, "any_id");
    assert.equal(
      res.code,
      "INTERNAL_ERROR",
      `expected INTERNAL_ERROR for an unreadable ledger; got ${res.code}: ${res.message}`,
    );
    assert.ok(
      res.message.startsWith(`failed to read source ledger ${SOURCE}: `),
      `message must be the preserved read-failure exit; got ${res.message}`,
    );
    assert.match(res.message, /EACCES/, "the underlying errno must survive into the message");
  } finally {
    chmodSync(p, 0o600);
  }
});

test("T-B3g mid-scan read failure (EISDIR) → INTERNAL_ERROR, never NOT_FOUND", async () => {
  // openSync succeeds on a directory; the FIRST readSync throws EISDIR. That is
  // a genuine mid-scan failure, and streamLedgerLines reports it on
  // counts.readError rather than throwing.
  const SOURCE = "chat-s9-eisdir";
  const p = join(B_SOURCES, `${SOURCE}.jsonl`);
  mkdirSync(p, { recursive: true, mode: 0o700 });
  const res = await callPromote(SOURCE, "any_id");
  assert.equal(
    res.code,
    "INTERNAL_ERROR",
    `expected INTERNAL_ERROR for a mid-scan read failure; got ${res.code}: ${res.message}`,
  );
  assert.ok(
    res.message.startsWith(`failed to read source ledger ${SOURCE}: `),
    `message must be the preserved read-failure exit; got ${res.message}`,
  );
  assert.match(res.message, /EISDIR/, "the underlying errno must survive into the message");
});

// ===========================================================================
// SITE B — T-B4: an unparseable mid-file line must not abort the scan.
// ===========================================================================
test("T-B4 unparseable mid-file line does not abort the scan", async () => {
  const SOURCE = "chat-s9-torn";
  const TARGET = "s9_after_torn_line";
  const body =
    JSON.stringify(sourceRow("s9_before_torn", { source_policy: { consent_basis: "first_party" } })) +
    "\n" +
    '{"broken": ' +
    "\n" +
    "not json at all {{{\n" +
    JSON.stringify(sourceRow(TARGET)) + // no source_policy → CONSENT_BLOCKED
    "\n";
  writeSourceLedger(SOURCE, body);
  const res = await callPromote(SOURCE, TARGET);
  assert.equal(
    res.code,
    "CONSENT_BLOCKED",
    `the row AFTER two unparseable lines must still be found; got ${res.code}: ${res.message}`,
  );
});

// ===========================================================================
// SITE B — T-B5: bounded retention. Exactly one row may be retained.
// ===========================================================================
test("T-B5 bounded retention: a 50,000-row source ledger costs a small fraction of its bytes", async () => {
  const SOURCE = "chat-s9-retention";
  const N = 50_000;
  const TARGET = `s9_ret_${N - 1}`; // LAST row → the scan runs end-to-end
  const p = join(B_SOURCES, `${SOURCE}.jsonl`);
  {
    const fd = openSync(p, "w", 0o600);
    let buf = "";
    for (let i = 0; i < N; i++) {
      const row =
        i === N - 1
          ? sourceRow(`s9_ret_${i}`, {
              // no source_policy → CONSENT_BLOCKED, which resolves BEFORE the
              // handler's embed call, so this case needs no embed server.
              filler: { user_text: "u".repeat(600), assistant_text: "a".repeat(200) },
            })
          : sourceRow(`s9_ret_${i}`, {
              source_policy: { consent_basis: "first_party" },
              filler: { user_text: "u".repeat(600), assistant_text: "a".repeat(200) },
            });
      buf += JSON.stringify(row) + "\n";
      if (buf.length > 1 << 20) {
        writeSync(fd, buf);
        buf = "";
      }
    }
    if (buf.length > 0) writeSync(fd, buf);
    closeSync(fd);
  }
  const bytes = statSync(p).size;
  assert.ok(bytes > 20_000_000, `retention fixture is only ${bytes} B — too small to be a bound`);

  const before = process.memoryUsage().heapUsed;
  const res = await callPromote(SOURCE, TARGET);
  const after = process.memoryUsage().heapUsed;
  const delta = after - before;
  const ratio = delta / bytes;

  assert.equal(
    res.code,
    "CONSENT_BLOCKED",
    `the last row must be found; got ${res.code}: ${res.message}`,
  );
  // MEASURED THIS SESSION through this very assertion, on the 52,855,512 B /
  // 50,000-row fixture built above:
  //   pre-fix (readFileSync + split + linear scan) : 1.488 B/B  (one RED run)
  //   post-fix (streamLedgerLines, one-row retain) : 0.149, 0.149, 0.149,
  //                                                 0.151, 0.468 B/B (5 runs)
  // The 0.468 is a V8 heap-growth outlier, not a retention change. The 0.75
  // budget sits above the worst observed GREEN and below the RED with margin
  // on both sides.
  assert.ok(
    ratio < 0.75,
    `bounded retention violated: heapUsed grew ${delta} B across a ${bytes} B fixture ` +
      `(ratio ${ratio.toFixed(3)} heap bytes per file byte; budget 0.75). ` +
      "Measured this session: the whole-file read this replaces = 1.488 B/B; " +
      "the streaming one-row-retention implementation = 0.149-0.468 B/B.",
  );
  process.stdout.write(
    `  T-B5 measured: fixture ${bytes} B, heapUsed delta ${delta} B, ratio ${ratio.toFixed(3)} B/B\n`,
  );
});

// ===========================================================================
// SITE A — spawned-child driver.
//
// Importing scripts/backfill-from-sources.mjs also loads daemons/watermark.js
// at module scope, so every Site A case runs in its OWN child process with its
// OWN mkdtemp root. The child sets every base-dir override at the top of its
// body (before the dynamic import of config.js) AND the spawn passes the same
// overrides in `env`, and it refuses to proceed unless memoryLedgerPath()
// resolves inside the temp root.
//
// PRE-FIX SAFETY. The over-cap fixture is written to the ledger path BEFORE the
// import. Against the unmodified script the module body invokes main(), whose
// FIRST log line calls memLineCount() and throws ERR_STRING_TOO_LONG — so the
// tick loop is never reached and no daemon work happens even in the RED run.
// ===========================================================================
const A_HEAD_ROWS = 2;
const A_TAIL_ROWS = 6;

function memRow(id) {
  return {
    id,
    kind: "fact",
    content: `content for ${id}`,
    source_refs: [{ source: "chat-s9", source_msg_id: `${id}_msg` }],
    features: { salience: { score: 0.5 } },
    created_at: "2026-08-01T00:00:00.000Z",
  };
}

function siteAChildSource(root, ledgersDir) {
  const j = (v) => JSON.stringify(v);
  return `
import { chmodSync, closeSync, openSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const ROOT = ${j(root)};
const LEDGERS_DIR = ${j(ledgersDir)};
process.env.MEMORY_ROOT = ROOT;
process.env.LEDGERS_BASE_DIR = LEDGERS_DIR;
process.env.STORAGE_BASE_DIR = join(ROOT, "storage");
process.env.POLICY_BASE_DIR = join(ROOT, "policy");
process.env.DAEMONS_BASE_DIR = join(ROOT, "daemons");
process.env.CONNECTORS_BASE_DIR = join(ROOT, "connectors");
process.env.HOOKS_BASE_DIR = join(ROOT, "hooks");
process.env.TELEMETRY_BASE_DIR = join(ROOT, "telemetry");

const CASE = process.argv[2];
const emit = (o) => process.stdout.write("RESULT " + JSON.stringify(o) + "\\n");

// Hermeticity gate — assert BEFORE importing anything that could act.
const cfg = await import(${j(pathToFileURL(CONFIG_MODULE).href)});
const LEDGER = cfg.memoryLedgerPath();
if (!LEDGER.startsWith(ROOT + "/")) {
  process.stderr.write("CHILD ABORT: memoryLedgerPath() = " + LEDGER + " is outside " + ROOT + "\\n");
  process.exit(9);
}

// The over-cap fixture is already at LEDGER (the parent wrote it). Importing
// the unmodified script runs main(), which dies here; importing the fixed
// script runs nothing (main-guard).
const mod = await import(${j(pathToFileURL(BACKFILL_SCRIPT).href)});
if (typeof mod.memLineCount !== "function" || typeof mod.memSample !== "function") {
  process.stderr.write(
    "CHILD ABORT: scripts/backfill-from-sources.mjs exports memLineCount=" +
      typeof mod.memLineCount + " memSample=" + typeof mod.memSample + "\\n",
  );
  process.exit(8);
}

function writeLedger(body) {
  writeFileSync(LEDGER, body, { mode: 0o600 });
}

// PRE-CHANGE ORACLES — the exact bodies this node replaces, verbatim, run on
// SMALL fixtures only. These are a differential oracle for parity, not a
// re-implementation of the new code (the assertions drive mod.* directly).
function oldMemLineCount() {
  const buf = readFileSync(LEDGER, "utf8");
  if (buf.length === 0) return 0;
  return buf.split("\\n").filter((l) => l.length > 0).length;
}
function oldMemSample(n) {
  const buf = readFileSync(LEDGER, "utf8");
  const lines = buf.split("\\n").filter((l) => l.length > 0);
  const out = [];
  for (let i = Math.max(0, lines.length - n); i < lines.length; i++) {
    try { out.push(JSON.parse(lines[i])); } catch { /* skip */ }
  }
  return out;
}

if (CASE === "overcap") {
  const count = mod.memLineCount();
  const sample = mod.memSample(5);
  emit({ count, sampleIds: sample.map((r) => r && r.id), sampleLen: sample.length });
} else if (CASE === "parity") {
  const shapes = {
    "trailing-newline": '{"id":"r1"}\\n{"id":"r2"}\\n{"id":"r3"}\\n',
    "no-trailing-newline": '{"id":"r1"}\\n{"id":"r2"}\\n{"id":"r3"}',
    "blank-lines": '{"id":"r1"}\\n\\n\\n{"id":"r2"}\\n\\n{"id":"r3"}\\n\\n',
    "mid-file-unparseable": '{"id":"r1"}\\nnot json {{{\\n{"id":"r3"}\\n',
    "empty-file": "",
    "newlines-only": "\\n\\n\\n\\n",
  };
  const rows = [];
  for (const [name, body] of Object.entries(shapes)) {
    writeLedger(body);
    rows.push({ name, actual: mod.memLineCount(), oracle: oldMemLineCount() });
  }
  // memSample differential: the last-5 window contains one unparseable line.
  const seven = [
    '{"id":"s1"}', '{"id":"s2"}', '{"id":"s3"}', '{"id":"s4"}',
    "TORN LINE {{{", '{"id":"s6"}', '{"id":"s7"}',
  ].join("\\n") + "\\n";
  writeLedger(seven);
  const newSample = mod.memSample(5).map((r) => r && r.id);
  const oldSample = oldMemSample(5).map((r) => r && r.id);
  emit({ rows, newSample, oldSample, zeroGuard: mod.memSample(0).length });
} else if (CASE === "retention") {
  const N = 20000;
  const fd = openSync(LEDGER, "w", 0o600);
  let buf = "";
  for (let i = 0; i < N; i++) {
    buf += JSON.stringify({
      id: "mem_" + i, kind: "fact", content: "c".repeat(300),
      source_refs: [{ source: "chat-s9", source_msg_id: "m_" + i }],
      features: { salience: { score: 0.5 } },
    }) + "\\n";
    if (buf.length > (1 << 20)) { writeSync(fd, buf); buf = ""; }
  }
  if (buf.length > 0) writeSync(fd, buf);
  closeSync(fd);
  const bytes = statSync(LEDGER).size;

  global.gc(); global.gc();
  const retBefore = process.memoryUsage().heapUsed;
  const sample = mod.memSample(5);
  const transient = process.memoryUsage().heapUsed - retBefore;
  global.gc(); global.gc();
  const retained = process.memoryUsage().heapUsed - retBefore;

  global.gc(); global.gc();
  const cBefore = process.memoryUsage().heapUsed;
  const count = mod.memLineCount();
  const cTransient = process.memoryUsage().heapUsed - cBefore;
  global.gc(); global.gc();
  const cRetained = process.memoryUsage().heapUsed - cBefore;

  emit({
    bytes, rows: N, count,
    sampleLen: sample.length, sampleIds: sample.map((r) => r && r.id),
    sampleRetained: retained, sampleTransient: transient,
    countRetained: cRetained, countTransient: cTransient,
  });
} else if (CASE === "readerror") {
  writeLedger('{"id":"only"}\\n');
  chmodSync(LEDGER, 0o000);
  let count, sampleLen;
  try {
    count = mod.memLineCount();
    sampleLen = mod.memSample(5).length;
  } finally {
    chmodSync(LEDGER, 0o600);
  }
  emit({ count, sampleLen });
} else {
  process.stderr.write("CHILD ABORT: unknown case " + CASE + "\\n");
  process.exit(7);
}
`;
}

function runSiteACase(caseName, extraNodeArgs = []) {
  const root = mkdtempSync(join(tmpdir(), `memsys-s9-siteA-${caseName}-`));
  const ledgersDir = join(root, "ledgers");
  for (const d of [
    ledgersDir,
    join(root, "storage"),
    join(root, "storage", "sources"),
    join(root, "policy"),
    join(root, "daemons"),
    join(root, "connectors"),
    join(root, "hooks"),
    join(root, "telemetry"),
  ]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
  }

  // The over-cap fixture must be in place BEFORE the child imports the script.
  const head = [];
  for (let i = 0; i < A_HEAD_ROWS; i++) head.push(memRow(`mem_h${i}`));
  const tail = [];
  for (let i = 0; i < A_TAIL_ROWS; i++) tail.push(memRow(`mem_t${i}`));
  const ledger = makeOverCapLedger(ledgersDir, "memory.jsonl", head, tail);
  assertOverCapShape(ledger, A_HEAD_ROWS + A_TAIL_ROWS, `Site A/${caseName}`);

  const childPath = join(root, "child.mjs");
  writeFileSync(childPath, siteAChildSource(root, ledgersDir), { mode: 0o700 });

  const res = spawnSync(
    process.execPath,
    [...extraNodeArgs, childPath, caseName],
    {
      encoding: "utf8",
      timeout: 120000,
      env: {
        ...process.env,
        MEMORY_ROOT: root,
        LEDGERS_BASE_DIR: ledgersDir,
        STORAGE_BASE_DIR: join(root, "storage"),
        POLICY_BASE_DIR: join(root, "policy"),
        DAEMONS_BASE_DIR: join(root, "daemons"),
        CONNECTORS_BASE_DIR: join(root, "connectors"),
        HOOKS_BASE_DIR: join(root, "hooks"),
        TELEMETRY_BASE_DIR: join(root, "telemetry"),
      },
    },
  );
  const line = (res.stdout || "")
    .split("\n")
    .find((l) => l.startsWith("RESULT "));
  return {
    root,
    ledger,
    status: res.status,
    signal: res.signal,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    result: line ? JSON.parse(line.slice("RESULT ".length)) : null,
  };
}

function assertChildOk(r, label) {
  assert.equal(
    r.status,
    0,
    `${label}: child exited ${r.status} (signal ${r.signal}).\n--- stderr ---\n${r.stderr}\n--- stdout ---\n${r.stdout}`,
  );
  assert.ok(r.result, `${label}: child produced no RESULT line.\n--- stderr ---\n${r.stderr}`);
}

// ===========================================================================
// SITE A — T-A1: over-cap ledger. memLineCount + memSample must both work.
// ===========================================================================
test("T-A1 over-cap memory.jsonl: memLineCount counts and memSample(5) returns the last 5 rows", () => {
  const r = runSiteACase("overcap");
  assertChildOk(r, "T-A1");
  // The 600 MB NUL run is not a row: the pre-change split/filter would have
  // counted it, but that implementation cannot read this file at all
  // (ERR_STRING_TOO_LONG), so there is no observable divergence.
  assert.equal(
    r.result.count,
    A_HEAD_ROWS + A_TAIL_ROWS,
    `expected ${A_HEAD_ROWS + A_TAIL_ROWS} non-empty rows, got ${r.result.count}`,
  );
  assert.equal(r.result.sampleLen, 5, "memSample(5) must return 5 rows");
  assert.deepEqual(
    r.result.sampleIds,
    ["mem_t1", "mem_t2", "mem_t3", "mem_t4", "mem_t5"],
    "memSample(5) must return the LAST 5 parsed rows, in file order",
  );
});

// ===========================================================================
// SITE A — T-A2: parity with the pre-change semantics on six small shapes.
// ===========================================================================
test("T-A2 parity: memLineCount equals split/filter on six shapes; memSample matches the old body", () => {
  const r = runSiteACase("parity");
  assertChildOk(r, "T-A2");
  const expectedShapes = [
    "trailing-newline",
    "no-trailing-newline",
    "blank-lines",
    "mid-file-unparseable",
    "empty-file",
    "newlines-only",
  ];
  assert.deepEqual(
    r.result.rows.map((x) => x.name),
    expectedShapes,
    "all six shapes must be exercised",
  );
  for (const row of r.result.rows) {
    assert.equal(
      row.actual,
      row.oracle,
      `shape "${row.name}": memLineCount() returned ${row.actual}, ` +
        `readFileSync(p,"utf8").split("\\n").filter(l=>l.length>0).length returned ${row.oracle}`,
    );
  }
  // Non-vacuity: the shapes must not all be zero.
  assert.deepEqual(
    r.result.rows.map((x) => x.oracle),
    [3, 3, 3, 3, 0, 0],
    "the oracle counts pin the six shapes; if these drift the parity check is hollow",
  );
  assert.deepEqual(
    r.result.newSample,
    r.result.oldSample,
    "memSample(5) must match the pre-change body on a last-5 window containing a torn line",
  );
  // The fixture's 7 non-empty lines are s1 s2 s3 s4 TORN s6 s7, so the last-5
  // WINDOW is s3 s4 TORN s6 s7 and the torn line is DROPPED from the result
  // rather than pulling s2 forward: 4 rows, not 5. A ring buffer over PARSED
  // rows would have returned 5.
  assert.deepEqual(
    r.result.newSample,
    ["s3", "s4", "s6", "s7"],
    "the torn line must be dropped from the last-5 window, not backfilled",
  );
  assert.equal(r.result.zeroGuard, 0, "memSample(0) must return []");
});

// ===========================================================================
// SITE A — T-A3: bounded retention.
// ===========================================================================
test("T-A3 bounded retention: memSample(5) over a 20,000-row ledger retains O(n), not O(file)", () => {
  // --expose-gc makes the retained-heap measurement exact: the naive swap this
  // guards against (retain every row) would show a retained delta on the order
  // of the fixture size, not a few hundred KiB.
  const r = runSiteACase("retention", ["--expose-gc"]);
  assertChildOk(r, "T-A3");
  const { bytes, rows, count, sampleLen, sampleIds, sampleRetained, sampleTransient, countRetained, countTransient } =
    r.result;
  assert.equal(count, rows, `memLineCount() returned ${count} for a ${rows}-row fixture`);
  assert.equal(sampleLen, 5, "memSample(5) must return exactly 5 rows");
  assert.deepEqual(
    sampleIds,
    ["mem_19995", "mem_19996", "mem_19997", "mem_19998", "mem_19999"],
    "memSample(5) must return the last 5 rows in file order",
  );
  const sampleRatio = sampleRetained / bytes;
  const countRatio = countRetained / bytes;
  assert.ok(
    sampleRatio < 0.05,
    `memSample(5) retention violated: retained ${sampleRetained} B across a ${bytes} B / ${rows}-row ` +
      `fixture (ratio ${sampleRatio.toFixed(4)}; budget 0.05). transient delta was ${sampleTransient} B.`,
  );
  assert.ok(
    countRatio < 0.05,
    `memLineCount retention violated: retained ${countRetained} B across a ${bytes} B / ${rows}-row ` +
      `fixture (ratio ${countRatio.toFixed(4)}; budget 0.05). transient delta was ${countTransient} B.`,
  );
  process.stdout.write(
    `  T-A3 measured: fixture ${bytes} B / ${rows} rows; memSample(5) retained ${sampleRetained} B ` +
      `(ratio ${sampleRatio.toFixed(4)}, transient ${sampleTransient} B); memLineCount retained ` +
      `${countRetained} B (ratio ${countRatio.toFixed(4)}, transient ${countTransient} B)\n`,
  );
});

// ===========================================================================
// SITE A — T-A4: an unreadable-but-existing ledger is LOUD, never a silent 0.
// ===========================================================================
test("T-A4 unreadable ledger emits a JSONL breadcrumb on stderr, not a silent mem_lines: 0", () => {
  const r = runSiteACase("readerror");
  assertChildOk(r, "T-A4");
  const breadcrumbs = r.stderr
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((o) => o && o.kind === "mem_read_error");
  assert.ok(
    breadcrumbs.length >= 2,
    `expected a mem_read_error breadcrumb from BOTH memLineCount and memSample; ` +
      `found ${breadcrumbs.length}.\n--- stderr ---\n${r.stderr}`,
  );
  assert.deepEqual(
    breadcrumbs.map((b) => b.fn).sort(),
    ["memLineCount", "memSample"],
    "each breadcrumb must name the function that hit the read failure",
  );
  for (const b of breadcrumbs) {
    assert.ok(
      typeof b.path === "string" && b.path.endsWith("memory.jsonl"),
      `breadcrumb must carry the ledger path; got ${JSON.stringify(b)}`,
    );
    assert.match(
      String(b.error),
      /EACCES/,
      `breadcrumb must carry the underlying errno; got ${JSON.stringify(b)}`,
    );
  }
  // The counts still degrade to 0 — the script's stdout shape is unchanged by
  // design — but the failure is now observable on stderr.
  assert.equal(r.result.count, 0);
  assert.equal(r.result.sampleLen, 0);
});
