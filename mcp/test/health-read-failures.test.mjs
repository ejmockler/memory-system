// health-read-failures.test.mjs — typed read-failure visibility for memory_health.
//
// WHY THIS SUITE EXISTS. Node's maximum string length is
// require("node:buffer").constants.MAX_STRING_LENGTH = 536,870,888 bytes on the
// Node v24 this repo runs. Production ledgers/memory.jsonl passed that cap
// around 2026-06-02 and measured 3,054,950,767 bytes (5.69x the cap) on
// 2026-08-11. Every reader doing readFileSync(path, "utf8") on it throws
// ERR_STRING_TOO_LONG, and several swallowed that in a bare `catch { return
// []; }` — which made an UNREADABLE ledger indistinguishable from an EMPTY one
// for roughly ten weeks. A live memory_health call on 2026-08-11T06:44:10Z
// mentioned neither memory.jsonl nor recall.jsonl anywhere in the envelope, and
// served synthesis aggregates built_at 2026-08-09T03:04:44.004Z — 51.7 hours
// stale — with no note saying so.
//
// The three probes under test are notes-only (the memory_health envelope has a
// CLOSED top-level field set, health.js:1129-1131) and statSync-only (health.js
// is on a latency budget, health.js:78-82):
//
//   ledger_over_string_cap:      main + source ledgers past the string cap
//   ledger_stat_error:           a non-ENOENT stat errno on a MAIN ledger
//                                (previously laundered into "missing")
//   synthesis_aggregates_stale:  served last-known-good aggregates older than 6h
//
// T5 is the non-vacuity control: a readable, under-cap, fresh tree must emit
// NONE of the three. Without it all three probes could be hardcoded always-on
// and this suite would still be green.
//
// C1 (rebuild-child observability) added T6-T8 and two more notes-only probes
// to T5's negative-control list:
//
//   synthesis_rebuild_failed:        the last detached rebuild child ended
//                                    ok:false and no last-good has been
//                                    written since (rebuild-outcome.json)
//   synthesis_rebuild_never_completed  no last-good built_at, no outcome file,
//                                    no live rebuild.pending marker
//
// T6 is the FIRST execution of the generated child source anywhere in the
// suite (health-real-data.test.mjs test 7 uses a spawn spy). It spawns the
// real detached child through the default spawnImpl; precedent for running
// `node --input-type=module -e` from a test: bm25-full-rebuild.test.mjs:119
// (runNodeModule).
//
// HERMETICITY: every case runs in its own mkdtempSync tree and passes an
// explicit opts object with scheduleRebuild stubbed. buildHealthData is NEVER
// called with no arguments or against production paths — on the live 3 GB
// ledger the degrade path spawns a detached rebuild child that writes multi-MB
// state.
//
// Run: node --test test/health-read-failures.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// lib/config.js binds its paths at module-load time, so these MUST be set
// before the dynamic import below (pattern: health-real-data.test.mjs:34-51).
// Probes that do not take a path override (telegram drain, effective-empty-rate,
// cursor lag) resolve through config.js and would otherwise read the live tree.
const ENV_ROOT = mkdtempSync(join(tmpdir(), "memsys-health-readfail-env-"));
mkdirSync(join(ENV_ROOT, "policy"), { recursive: true });
mkdirSync(join(ENV_ROOT, "storage"), { recursive: true });
mkdirSync(join(ENV_ROOT, "ledgers"), { recursive: true });
process.env.MEMORY_ROOT = ENV_ROOT;
process.env.POLICY_BASE_DIR = join(ENV_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(ENV_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(ENV_ROOT, "ledgers");
process.env.TELEMETRY_BASE_DIR = join(ENV_ROOT, "telemetry");
// Operator identity is resolved once at module load: point it at the synthetic
// identity file before the dynamic import below, and derive the registered
// address from that file instead of hardcoding one.
const IDENTITY_FILE = fileURLToPath(
  new URL("./fixtures/operator-identity.synthetic.json", import.meta.url),
);
process.env.MEMORY_OPERATOR_IDENTITY_FILE = IDENTITY_FILE;
const OPERATOR_EMAIL = JSON.parse(readFileSync(IDENTITY_FILE, "utf8")).emails[0];

const TEMP_ROOTS = [ENV_ROOT];
process.on("exit", () => {
  for (const dir of TEMP_ROOTS) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

const { buildHealthData, scheduleReducerStateRebuild } = await import("../lib/tools/health.js");

const NOW = new Date("2026-08-11T12:00:00Z");

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "memsys-health-readfail-"));
  TEMP_ROOTS.push(root);
  mkdirSync(join(root, "ledgers"), { recursive: true });
  mkdirSync(join(root, "storage", "sources"), { recursive: true });
  mkdirSync(join(root, "storage", "health-reducer-state"), { recursive: true });
  mkdirSync(join(root, "indices"), { recursive: true });
  return root;
}

// Deterministic JSONL filler. Rows carry the shape the health reducers fold
// (ts + type) so the healthy path is exercised, not just the throw path.
function jsonlBytes(approxBytes) {
  const lines = [];
  let total = 0;
  let i = 0;
  while (total < approxBytes) {
    const line =
      JSON.stringify({
        ts: "2026-08-11T00:00:00.000Z",
        type: "fact",
        id: `f${i}`,
        pad: "x".repeat(40),
      }) + "\n";
    lines.push(line);
    total += Buffer.byteLength(line);
    i += 1;
  }
  return lines.join("");
}

function optsFor(root, extra) {
  return {
    sourcesDir: join(root, "storage", "sources"),
    memoryLedgerPath: join(root, "ledgers", "memory.jsonl"),
    recallLogPath: join(root, "ledgers", "recall.jsonl"),
    indicesDir: join(root, "indices"),
    healthStateDir: join(root, "storage", "health-reducer-state"),
    now: NOW,
    // MUST be stubbed: the real scheduler spawns a detached rebuild child.
    scheduleRebuild: () => {},
    // Defeat the in-process warm envelope cache between calls.
    envelopeCacheBucketMs: 1,
    ...(extra || {}),
  };
}

// ---------------------------------------------------------------------------
// T1 — over-cap MAIN ledger is named, with bytes/cap/ratio in the note.
// ---------------------------------------------------------------------------
test("T1 over-cap main ledger emits ledger_over_string_cap: memory.jsonl", async () => {
  const root = makeRoot();
  writeFileSync(join(root, "ledgers", "memory.jsonl"), jsonlBytes(4096));

  const data = await buildHealthData(optsFor(root, { stringCapBytes: 1024 }));
  const notes = data.health_notes;
  assert.ok(Array.isArray(notes), "health_notes must be an array");

  const note = notes.find((n) => n.startsWith("ledger_over_string_cap: memory.jsonl"));
  assert.ok(
    note,
    `expected a ledger_over_string_cap: memory.jsonl note, got ${JSON.stringify(notes)}`,
  );
  assert.match(note, /bytes=\d+/, "note must carry bytes=");
  assert.match(note, /cap=1024/, "note must carry the effective cap=");
  assert.match(note, /ratio=\d+\.\d+/, "note must carry ratio=");

  // CLOSED-ENVELOPE + ledger_byte_counts invariants: the signal rides on
  // health_notes only and never widens the source-ledger byte map.
  assert.ok(
    !Object.prototype.hasOwnProperty.call(data.ledger_byte_counts, "memory.jsonl"),
    "memory.jsonl must NOT be added to ledger_byte_counts (source ledgers only)",
  );
  assert.ok(
    !Object.prototype.hasOwnProperty.call(data.ledger_byte_counts, "recall.jsonl"),
    "recall.jsonl must NOT be added to ledger_byte_counts (source ledgers only)",
  );
});

// ---------------------------------------------------------------------------
// T2 — over-cap SOURCE ledger reuses the byte count the existing loop already
// computed (zero additional statSync calls).
// ---------------------------------------------------------------------------
test("T2 over-cap source ledger emits ledger_over_string_cap: auto-memory.jsonl", async () => {
  const root = makeRoot();
  writeFileSync(join(root, "storage", "sources", "auto-memory.jsonl"), jsonlBytes(4096));

  const data = await buildHealthData(optsFor(root, { stringCapBytes: 1024 }));
  const notes = data.health_notes;

  const note = notes.find((n) => n.startsWith("ledger_over_string_cap: auto-memory.jsonl"));
  assert.ok(
    note,
    `expected a ledger_over_string_cap: auto-memory.jsonl note, got ${JSON.stringify(notes)}`,
  );
  assert.match(note, /bytes=\d+/, "note must carry bytes=");
  assert.match(note, /cap=1024/, "note must carry the effective cap=");
});

// ---------------------------------------------------------------------------
// T3 — an UNREADABLE main ledger is not "missing".
//
// memoryLedgerPath is routed THROUGH a regular file, so statSync throws
// ENOTDIR. That is deterministic on this machine, needs no chmod, and works for
// any user including root. chmod 000 would NOT exercise this path: statSync
// still succeeds on a mode-000 file.
//
// Also pins the dedup invariant: the main-ledger pass and planReducerFold stat
// the same path in the same call, so a single fault must yield a single note.
// ---------------------------------------------------------------------------
test("T3 unreadable main ledger emits exactly one ENOTDIR ledger_stat_error", async () => {
  const root = makeRoot();
  const blocker = join(root, "ledgers", "blocker.jsonl");
  writeFileSync(blocker, "not-a-directory\n");

  const data = await buildHealthData(
    optsFor(root, { memoryLedgerPath: join(blocker, "memory.jsonl") }),
  );
  const notes = data.health_notes;

  const statErrors = notes.filter((n) => n.startsWith("ledger_stat_error:"));
  assert.ok(
    statErrors.length > 0,
    `expected a ledger_stat_error: note, got ${JSON.stringify(notes)}`,
  );
  assert.ok(
    statErrors.some((n) => n.includes("ENOTDIR")),
    `expected an ENOTDIR ledger_stat_error, got ${JSON.stringify(statErrors)}`,
  );

  const memoryStatErrors = statErrors.filter((n) => n.includes("memory.jsonl"));
  assert.equal(
    memoryStatErrors.length,
    1,
    `exactly one ledger_stat_error must mention memory.jsonl (no duplicate from the ` +
      `planReducerFold statErrors channel), got ${JSON.stringify(memoryStatErrors)}`,
  );

  // The unreadable ledger must NOT be reported as absent.
  assert.ok(
    !notes.some((n) => n.startsWith("ledger_missing: memory.jsonl")),
    "an unreadable main ledger must not be laundered into ledger_missing:",
  );
});

// ---------------------------------------------------------------------------
// T4 — served last-known-good aggregates carry their age.
//
// AGE ARITHMETIC (spec correction): the Agent-Prompt says "roughly 51 hours",
// but 51.7h was the age against the LIVE time_now of 2026-08-11T06:44:10Z.
// Against the pinned now of 2026-08-11T12:00:00Z the true age is
// 48h + 8h55m15.996s = 56.92h. Asserting ~51 here would be arithmetically wrong.
// ---------------------------------------------------------------------------
test("T4 stale served aggregates emit synthesis_aggregates_stale with age_h", async () => {
  const root = makeRoot();
  const builtAt = "2026-08-09T03:04:44.004Z";
  writeFileSync(
    join(root, "storage", "health-reducer-state", "last-good.json"),
    JSON.stringify({
      saved_at: builtAt,
      synthesis_coverage: { built_at: builtAt, window_days: 7 },
      drift_alerts: { built_at: builtAt },
    }),
  );
  // state.json intentionally absent + a non-empty ledger + a zero inline budget
  // => planReducerFold returns inline:false and the degrade branch runs.
  writeFileSync(join(root, "ledgers", "memory.jsonl"), jsonlBytes(4096));

  const data = await buildHealthData(optsFor(root, { inlineFoldMaxBytes: 0 }));
  const notes = data.health_notes;

  // The pre-existing degrade contract must be intact and byte-identical.
  assert.ok(
    notes.some((n) => n.startsWith("synthesis_state_rebuilding:")),
    `expected the degrade branch to run, got ${JSON.stringify(notes)}`,
  );

  const note = notes.find((n) => n.startsWith("synthesis_aggregates_stale:"));
  assert.ok(
    note,
    `expected a synthesis_aggregates_stale: note, got ${JSON.stringify(notes)}`,
  );
  assert.ok(note.includes(`built_at=${builtAt}`), `note must carry built_at=, got ${note}`);

  const m = note.match(/age_h=(-?\d+(?:\.\d+)?)/);
  assert.ok(m, `note must carry a numeric age_h=, got ${note}`);
  const ageH = Number(m[1]);
  assert.ok(
    ageH >= 56.8 && ageH <= 57.0,
    `age_h must be ~56.9 for built_at ${builtAt} against now ${NOW.toISOString()}, got ${ageH}`,
  );

  // PREFIX NON-COLLISION: health-real-data.test.mjs:363/:767 assert
  // !notes.some(n => n.startsWith("synthesis_state_rebuilding")) on OTHER
  // fixtures; the stale note must never borrow that prefix.
  assert.ok(
    !note.startsWith("synthesis_state_rebuilding"),
    "the stale note must not collide with the synthesis_state_rebuilding: prefix",
  );
});

// ---------------------------------------------------------------------------
// T5 — NON-VACUITY CONTROL. Readable, under-cap, fresh: all three probes silent.
// Without this the probes could be hardcoded to fire and nobody would know.
// ---------------------------------------------------------------------------
test("T5 negative control: healthy tree emits none of the three probes", async () => {
  const root = makeRoot();
  writeFileSync(join(root, "ledgers", "memory.jsonl"), jsonlBytes(2048));
  writeFileSync(join(root, "ledgers", "recall.jsonl"), jsonlBytes(2048));
  for (const f of ["auto-memory.jsonl", "chat-claude-code.jsonl", "telegram.jsonl"]) {
    writeFileSync(join(root, "storage", "sources", f), jsonlBytes(2048));
  }

  // stringCapBytes deliberately left at its default (MAX_STRING_LENGTH).
  const data = await buildHealthData(optsFor(root));
  const notes = data.health_notes;

  for (const prefix of [
    "ledger_over_string_cap:",
    "ledger_stat_error:",
    "synthesis_aggregates_stale:",
    "synthesis_rebuild_failed:",
    "synthesis_rebuild_never_completed",
  ]) {
    assert.ok(
      !notes.some((n) => n.startsWith(prefix)),
      `healthy tree must not emit ${prefix} — got ${JSON.stringify(notes)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// C1 helpers — a minimal reducer-foldable tree (row shapes copied from
// health-real-data.test.mjs:648-649) and an outcome poller.
// ---------------------------------------------------------------------------
function writeReducerRows(root) {
  writeFileSync(
    join(root, "ledgers", "memory.jsonl"),
    JSON.stringify({ kind: "fact", ts: "2026-06-30T00:00:00.000Z", features: {} }) + "\n",
  );
  writeFileSync(
    join(root, "ledgers", "recall.jsonl"),
    JSON.stringify({ kind: "recall", ts: "2026-06-30T00:00:00.000Z", populator: {} }) + "\n",
  );
}

function rebuildReq(root, extra) {
  const stateDir = join(root, "storage", "health-reducer-state");
  return {
    stateDir,
    statePath: join(stateDir, "state.json"),
    markerPath: join(stateDir, "rebuild.pending"),
    ledgerPath: join(root, "ledgers", "memory.jsonl"),
    recallLogPath: join(root, "ledgers", "recall.jsonl"),
    lastGoodPath: join(stateDir, "last-good.json"),
    reason: "test",
    ...(extra || {}),
  };
}

// The child writes rebuild-outcome.json atomically (tmp+rename) in its
// finally, so the first successful parse is a complete record.
async function pollOutcome(outcomePath, maxMs = 10_000, stepMs = 50) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (existsSync(outcomePath)) {
      try {
        return JSON.parse(readFileSync(outcomePath, "utf8"));
      } catch {
        /* torn read impossible via rename, but stay fail-soft */
      }
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return null;
}

// ---------------------------------------------------------------------------
// T6 — REAL spawn, success path. The generated child source runs for real
// (default spawnImpl), rebuilds state.json, refreshes last-good.json, writes
// rebuild-outcome.json BEFORE clearing its own marker, and logs its start
// event to rebuild.log. rmSync in finally so a detached child never outlives
// the tree it was pointed at.
// ---------------------------------------------------------------------------
test("T6 real rebuild child records ok:true outcome, last-good, and start event", async () => {
  const root = makeRoot();
  try {
    writeReducerRows(root);
    const req = rebuildReq(root);
    const outcomePath = join(req.stateDir, "rebuild-outcome.json");

    scheduleReducerStateRebuild(req); // REAL default spawnImpl
    const outcome = await pollOutcome(outcomePath);
    assert.ok(outcome, "rebuild-outcome.json must appear within 10s");
    assert.equal(outcome.schema, 1);
    assert.equal(outcome.ok, true, `outcome=${JSON.stringify(outcome)}`);
    assert.equal(outcome.error, null);
    assert.equal(outcome.state_saved, true);
    assert.equal(outcome.last_good_written, true);
    assert.equal(outcome.reason, "test");
    assert.ok(Number.isInteger(outcome.pid) && outcome.pid !== process.pid, "child pid recorded");
    assert.equal(typeof outcome.started_at, "string");
    assert.equal(typeof outcome.finished_at, "string");

    const lastGood = JSON.parse(readFileSync(req.lastGoodPath, "utf8"));
    assert.equal(typeof lastGood.saved_at, "string");
    assert.equal(
      typeof lastGood.synthesis_coverage?.built_at,
      "string",
      `last-good written by the child must carry a string built_at, got ${JSON.stringify(lastGood)}`,
    );
    assert.ok(existsSync(req.statePath), "state.json must be persisted by the child");

    // Outcome is written BEFORE the marker unlink; by the time we parsed the
    // outcome the unlink may still be a few microseconds away — poll briefly.
    const deadline = Date.now() + 2000;
    while (existsSync(req.markerPath) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(!existsSync(req.markerPath), "child must clear its own pid-matched marker");

    const log = readFileSync(join(req.stateDir, "rebuild.log"), "utf8");
    assert.ok(
      log.includes('"event":"rebuild.start"'),
      `rebuild.log must carry the start event, got ${JSON.stringify(log)}`,
    );
    assert.ok(log.includes('"reason":"test"'), "start event carries the reason");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T7 — REAL spawn, forced failure → note. statePath is routed THROUGH a
// regular file, so the child's mkdirSync(dirname(statePath), {recursive:true})
// throws inside its try. (Spec correction: on Node v24.15.0 recursive mkdir
// through a regular file reports EEXIST, not ENOTDIR — so the assertion is on
// a non-empty message_head, not on a specific errno.) The child must still
// write ok:false, and the degrade path must then surface
// `synthesis_rebuild_failed:` next to the untouched
// `synthesis_state_rebuilding:` contract.
// ---------------------------------------------------------------------------
test("T7 failed rebuild child records ok:false and the degrade path names it", async () => {
  const root = makeRoot();
  try {
    writeReducerRows(root);
    writeFileSync(join(root, "blocker"), "not-a-directory\n");
    const req = rebuildReq(root, { statePath: join(root, "blocker", "state.json") });
    const outcomePath = join(req.stateDir, "rebuild-outcome.json");

    scheduleReducerStateRebuild(req); // REAL default spawnImpl
    const outcome = await pollOutcome(outcomePath);
    assert.ok(outcome, "rebuild-outcome.json must appear within 10s");
    assert.equal(outcome.ok, false, `outcome=${JSON.stringify(outcome)}`);
    assert.equal(outcome.state_saved, false);
    assert.equal(outcome.last_good_written, false);
    assert.ok(outcome.error && typeof outcome.error.name === "string", "error.name recorded");
    assert.ok(
      typeof outcome.error.message_head === "string" && outcome.error.message_head.length > 0,
      `error.message_head must be non-empty, got ${JSON.stringify(outcome.error)}`,
    );
    assert.ok(!existsSync(req.lastGoodPath), "no last-good.json on a failed rebuild");

    const deadline = Date.now() + 2000;
    while (existsSync(req.markerPath) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(!existsSync(req.markerPath), "failed child still clears its own marker");

    // Degrade path against that state dir (scheduleRebuild stays stubbed, so
    // no second real child): state.json absent + ledger bytes + zero budget.
    const data = await buildHealthData(
      optsFor(root, { inlineFoldMaxBytes: 0, healthStateDir: req.stateDir }),
    );
    const notes = data.health_notes;
    assert.ok(
      notes.some((n) => n.startsWith("synthesis_state_rebuilding:")),
      `degrade contract must be intact, got ${JSON.stringify(notes)}`,
    );
    const failed = notes.find((n) => n.startsWith("synthesis_rebuild_failed:"));
    assert.ok(failed, `expected synthesis_rebuild_failed:, got ${JSON.stringify(notes)}`);
    assert.ok(failed.includes(`finished_at=${outcome.finished_at}`), `got ${failed}`);
    assert.ok(failed.includes(outcome.error.name), `note must carry error.name, got ${failed}`);
    assert.ok(
      !notes.includes("synthesis_rebuild_never_completed"),
      "an outcome file exists, so never_completed must not fire",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T8 — never completed: no state, no last-good, no outcome, no marker →
// `synthesis_rebuild_never_completed`. A LIVE marker (our own pid, fresh
// mtime) suppresses it: a child is running, nothing has failed yet.
// ---------------------------------------------------------------------------
test("T8 synthesis_rebuild_never_completed fires on an empty state dir, not under a live marker", async () => {
  const root = makeRoot();
  writeFileSync(join(root, "ledgers", "memory.jsonl"), jsonlBytes(4096));
  const stateDir = join(root, "storage", "health-reducer-state");

  const dataA = await buildHealthData(optsFor(root, { inlineFoldMaxBytes: 0 }));
  assert.ok(
    dataA.health_notes.some((n) => n.startsWith("synthesis_state_rebuilding:")),
    `degrade branch must run, got ${JSON.stringify(dataA.health_notes)}`,
  );
  assert.ok(
    dataA.health_notes.includes("synthesis_rebuild_never_completed"),
    `expected synthesis_rebuild_never_completed, got ${JSON.stringify(dataA.health_notes)}`,
  );
  assert.ok(
    !dataA.health_notes.some((n) => n.startsWith("synthesis_rebuild_failed:")),
    "no outcome file → no failed note",
  );

  // Live marker (scheduleRebuild is stubbed, so we plant the token ourselves).
  writeFileSync(
    join(stateDir, "rebuild.pending"),
    JSON.stringify({ pid: process.pid, requested_at: new Date().toISOString() }) + "\n",
    { mode: 0o600 },
  );
  // envelopeCacheBucketMs:1 in optsFor already defeats the warm cache.
  const dataB = await buildHealthData(optsFor(root, { inlineFoldMaxBytes: 0 }));
  assert.ok(
    dataB.health_notes.some((n) => n.startsWith("synthesis_state_rebuilding:")),
    "degrade branch must still run under the marker",
  );
  assert.ok(
    !dataB.health_notes.includes("synthesis_rebuild_never_completed"),
    `a live marker must suppress never_completed, got ${JSON.stringify(dataB.health_notes)}`,
  );
  assert.ok(existsSync(join(stateDir, "rebuild.pending")), "read-only check must not reclaim the marker");
});

// ---------------------------------------------------------------------------
// B2 (memory-roots) — operator alias-candidate note. The mail probe inside
// buildHealthData resolves storage/sources/mail.jsonl through config.js
// (STORAGE_BASE_DIR = ENV_ROOT/storage), so the fixture is written THERE, not
// under makeRoot()'s sourcesDir, and is removed in `finally` so T5's
// non-vacuity control (a clean tree emits no probe) keeps holding.
// Envelope contract: the note rides health_notes[] only — Object.keys(data)
// must equal the clean-tree key set (health-real-data.test.mjs
// AUTHORITATIVE_FIELDS is the authority; this is the same closed-envelope
// check from the other side).
// ---------------------------------------------------------------------------
test("T9 alias candidate: an unregistered address dominating one mail account surfaces as an advisory note inside the closed envelope", async () => {
  const root = makeRoot();
  writeFileSync(join(root, "ledgers", "memory.jsonl"), jsonlBytes(2048));
  writeFileSync(join(root, "ledgers", "recall.jsonl"), jsonlBytes(2048));

  const clean = await buildHealthData(optsFor(root));
  const cleanKeys = Object.keys(clean).sort();
  assert.ok(
    !clean.health_notes.some((n) => n.startsWith("operator_alias_candidate: ")),
    `clean tree must emit no alias note, got ${JSON.stringify(clean.health_notes)}`,
  );

  // T-a fixture (source-effective-empty-rate.test.mjs): account A is the
  // registered operator mailbox; account B holds 8 rows for
  // alice@example.test (6 direct + 2 list) and 1 for the operator -> share 8/9.
  const ACCT_A = "00000000-0000-4000-8000-00000000000A";
  const ACCT_B = "00000000-0000-4000-8000-00000000000B";
  let seq = 0;
  const row = ({ to, account, unsubscribe_type = 0 }) => {
    seq += 1;
    return JSON.stringify({
      // 1h apart, all within 7d of NOW (2026-08-11T12:00:00Z).
      ts: new Date(NOW.getTime() - (40 - seq) * 3_600_000).toISOString(),
      raw_content: {
        text: "body",
        unsubscribe_type,
        list_id_hash: null,
        mailbox_url: `imap://${account}/INBOX`,
        headers: { to },
      },
    });
  };
  const lines = [];
  for (let i = 0; i < 10; i++) lines.push(row({ to: `Alex <${OPERATOR_EMAIL}>`, account: ACCT_A }));
  for (let i = 0; i < 6; i++) lines.push(row({ to: "alice@example.test", account: ACCT_B }));
  for (let i = 0; i < 2; i++) lines.push(row({ to: "alice@example.test", account: ACCT_B, unsubscribe_type: 7 }));
  lines.push(row({ to: OPERATOR_EMAIL, account: ACCT_B }));

  const sourcesDir = join(ENV_ROOT, "storage", "sources");
  mkdirSync(sourcesDir, { recursive: true });
  const mailLedger = join(sourcesDir, "mail.jsonl");
  writeFileSync(mailLedger, lines.join("\n") + "\n");
  try {
    const data = await buildHealthData(optsFor(root));
    const notes = data.health_notes;
    const alias = notes.filter((n) => n.startsWith("operator_alias_candidate: "));
    assert.equal(alias.length, 1, `exactly one alias note, got ${JSON.stringify(notes)}`);
    assert.match(
      alias[0],
      /^operator_alias_candidate: \S+ \(\d+ direct non-list mails in 7d, (account_dominant|name_token|both)(, share=[01]\.\d{3})?\)$/,
    );
    assert.equal(
      alias[0],
      "operator_alias_candidate: alice@example.test (6 direct non-list mails in 7d, account_dominant, share=0.889)",
    );
    // Closed envelope: the signal rides notes only.
    assert.deepEqual(Object.keys(data).sort(), cleanKeys, "no new top-level health key");
    assert.ok(!("alias_candidates" in data), "alias_candidates is a probe-snapshot field, never a health key");
  } finally {
    rmSync(mailLedger, { force: true });
  }
});

// B5: a 6/6 account renders share=1.000 (fixed 3 dp — the earlier `${n}`
// interpolation rendered "share=1", which the pinned regex rejected).
test("T10 alias candidate: a 6/6 account renders share=1.000 inside the closed envelope", async () => {
  const root = makeRoot();
  writeFileSync(join(root, "ledgers", "memory.jsonl"), jsonlBytes(2048));
  writeFileSync(join(root, "ledgers", "recall.jsonl"), jsonlBytes(2048));

  const clean = await buildHealthData(optsFor(root));
  const cleanKeys = Object.keys(clean).sort();

  const ACCT_A = "00000000-0000-4000-8000-00000000000A";
  const ACCT_B = "00000000-0000-4000-8000-00000000000B";
  let seq = 0;
  const row = ({ to, account }) => {
    seq += 1;
    return JSON.stringify({
      ts: new Date(NOW.getTime() - (40 - seq) * 3_600_000).toISOString(),
      raw_content: {
        text: "body",
        unsubscribe_type: 0,
        list_id_hash: null,
        mailbox_url: `imap://${account}/INBOX`,
        headers: { to },
      },
    });
  };
  const lines = [];
  for (let i = 0; i < 10; i++) lines.push(row({ to: OPERATOR_EMAIL, account: ACCT_A }));
  for (let i = 0; i < 6; i++) lines.push(row({ to: "bravo@example.test", account: ACCT_B }));

  const sourcesDir = join(ENV_ROOT, "storage", "sources");
  mkdirSync(sourcesDir, { recursive: true });
  const mailLedger = join(sourcesDir, "mail.jsonl");
  writeFileSync(mailLedger, lines.join("\n") + "\n");
  try {
    const data = await buildHealthData(optsFor(root));
    const alias = data.health_notes.filter((n) => n.startsWith("operator_alias_candidate: "));
    assert.equal(alias.length, 1, `exactly one alias note, got ${JSON.stringify(data.health_notes)}`);
    assert.match(
      alias[0],
      /^operator_alias_candidate: \S+ \(\d+ direct non-list mails in 7d, (account_dominant|name_token|both)(, share=[01]\.\d{3})?\)$/,
    );
    assert.ok(alias[0].endsWith("account_dominant, share=1.000)"), `share renders as 1.000, got ${alias[0]}`);
    assert.equal(
      alias[0],
      "operator_alias_candidate: bravo@example.test (6 direct non-list mails in 7d, account_dominant, share=1.000)",
    );
    assert.deepEqual(Object.keys(data).sort(), cleanKeys, "no new top-level health key");
    assert.ok(!("alias_candidates" in data), "alias_candidates is a probe-snapshot field, never a health key");
  } finally {
    rmSync(mailLedger, { force: true });
  }
});
