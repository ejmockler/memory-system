// auto-drain.test.mjs — R4 reembed-drain drainer tests.
//
// Exercises daemons/reembed-drain.mjs runDrain() against mkdtemp fixtures
// with INJECTED healthCheck + repair fakes. NEVER touches live data:
// no ledgers/memory.jsonl, no policy/re-embed-sweep.jsonl, no embed server,
// no real reembed-local-4096.mjs spawn — every path is a fixture path.
//
// Hermetic: fixture root under mkdtempSync, removed on exit
// (mail-connector.test.mjs discipline). node:test + node:assert/strict.

import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Static import is safe: reembed-drain.mjs only auto-runs when invoked
// directly (INVOKED_DIRECTLY guard) — importing fires no drain.
import {
  buildRepairChildArgs,
  classifyWorkProof,
  defaultSidecarPath,
  lastChildProgressLine,
  measureBatchWork,
  parseChildWorkEvidence,
  parseLaunchctlPid,
  parsePositiveIntEnv,
  runDrain,
  scanSidecarForIds,
  sidecarLineId,
  stripChunkSuffix,
} from "../../daemons/reembed-drain.mjs";

// e1 EMBED-POPULATION CENSUS ARMS live in THIS suite by registered-suite
// discipline: SUITES in mcp/scripts/run-all-tests.mjs is a hand-maintained
// literal guarded by a parity check, and a new test/**/*.test.mjs file would
// break its parity gate. The census is drain-adjacent by construction — it
// imports the drain's chunk rule (stripChunkSuffix) so the `${id}#${k}` rule
// has exactly ONE definition tree-wide, and arm (g) pins that parity.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { captureCheckpoint, serializeCheckpoint } from "../lib/synthesis/ledger-checkpoint.js";
import {
  EMBED_POPULATION_BUCKETS,
  EmbedPopulationCensusError,
  INSTRUMENT_INVARIANT_CODES,
  UNMEASURABLE_BUCKET,
  censusEmbedPopulation,
  readHnswMembership,
  scanSidecarPopulation,
} from "../lib/recall/embed-population-census.js";

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), "auto-drain-test-"));
process.on("exit", () => {
  try { rmSync(FIXTURE_ROOT, { recursive: true, force: true }); } catch {}
});

// macOS pid_max is 99998 — this pid can never be alive (ESRCH), so a lock
// recording it is deterministically stale.
const DEAD_PID = 999999;

let fixtureSeq = 0;

// Build one fixture dir with a sweep file made of the given raw lines
// (each line gets "\n" appended — the appendReEmbedSweep shape). Returns
// paths + cumulative byte offsets: offsets[i] = byte offset AFTER line i.
function makeFixture(rawLines) {
  const dir = join(FIXTURE_ROOT, `fx-${fixtureSeq++}`);
  mkdirSync(join(dir, "policy"), { recursive: true });
  mkdirSync(join(dir, "logs"), { recursive: true });
  const sweepPath = join(dir, "policy", "re-embed-sweep.jsonl");
  const offsets = [];
  let body = "";
  for (const line of rawLines) {
    body += line + "\n";
    offsets.push(Buffer.byteLength(body, "utf8"));
  }
  writeFileSync(sweepPath, body, { mode: 0o600 });
  // R6 WORK PROOF: the drain measures the child's OUTPUT file, so every
  // fixture now owns a sidecar. It mirrors the real layout
  // (indices/<model>/vectors.jsonl) and starts EMPTY, which is the honest
  // starting state — never the live indices/qwen3-embedding-8b-fp16/
  // vectors.jsonl, which this suite must never open.
  const sidecarDir = join(dir, "indices", "qwen3-embedding-8b-fp16");
  mkdirSync(sidecarDir, { recursive: true });
  const sidecarPath = join(sidecarDir, "vectors.jsonl");
  writeFileSync(sidecarPath, "", { mode: 0o600 });
  return {
    dir,
    sweepPath,
    sidecarPath,
    cursorPath: join(dir, "policy", "re-embed-sweep.cursor"),
    lockPath: join(dir, "policy", "reembed-drain.lock"),
    logPath: join(dir, "logs", "reembed-drain.log"),
    offsets,
    sweepBody: body,
  };
}

// One sidecar line in the child's own shape. The child writes
// `JSON.stringify({ id: slice[k].id, v })` — id FIRST — and chunked facts write
// only `${factId}#${k}` ids. `vFirst` produces the opposite key order so the
// parser's JSON.parse fallback is exercised rather than merely asserted.
function sidecarLine(id, { vFirst = false } = {}) {
  const v = [0.5, -0.25, 0.125];
  return (vFirst ? JSON.stringify({ v, id }) : JSON.stringify({ id, v })) + "\n";
}

function appendSidecar(fx, ids, opts = {}) {
  if (ids.length === 0) return;
  appendFileSync(fx.sidecarPath, ids.map((id) => sidecarLine(id, opts)).join(""), { mode: 0o600 });
}

function sweepRow(factId) {
  return JSON.stringify({ fact_id: factId, ts: "2026-07-10T00:00:00.000Z" });
}

// Fake repair that records every call, WRITES one sidecar line per id it
// receives — exactly what the real child does — and succeeds.
//
// Every success-path test in this file routes through this one helper, so the
// pre-R6 cursor-arithmetic, throttle-argv and attribution assertions survive
// untouched while becoming OUTCOME-BACKED: they now run against a repair that
// really produced vectors, not one that merely claimed exit 0. A repair that
// writes nothing is now a distinct, deliberately-constructed fixture.
function recordingRepair(fx, opts = {}) {
  const calls = [];
  const fn = async (ids) => {
    calls.push([...ids]);
    const toWrite = typeof opts.writeIds === "function" ? opts.writeIds(ids) : ids;
    if (fx && fx.sidecarPath) appendSidecar(fx, toWrite, opts);
    return { ok: true, exitCode: 0, detail: null, ...(opts.result || {}) };
  };
  return { fn, calls };
}

// A repair that returns success and writes NOTHING — r2's accident shape, and
// the shape every production door in the child's main() can produce (an
// all-skipped non-finite batch, an empty-chunk filter that empties `items`,
// collectContents resolving zero rows).
function vacuousRepair(result = {}) {
  const calls = [];
  const fn = async (ids) => {
    calls.push([...ids]);
    return { ok: true, exitCode: 0, detail: null, ...result };
  };
  return { fn, calls };
}

const healthUp = async () => true;
const healthDown = async () => false;

function readCursor(cursorPath) {
  return JSON.parse(readFileSync(cursorPath, "utf8"));
}

function readLogRecords(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// (a) Batch consumption: BATCH=3 over 5 rows consumes exactly rows 1-3 and
// persists the byte offset after row 3; the second run consumes rows 4-5.
// Also: the sweep file is opened read-only (byte-identical after both runs)
// and the log carries ISO-timestamped structured records.
// ---------------------------------------------------------------------------
test("batch consumption advances the cursor exactly past processed rows", async () => {
  const rows = ["f1", "f2", "f3", "f4", "f5"].map(sweepRow);
  const fx = makeFixture(rows);
  const rep = recordingRepair(fx);
  const opts = {
    sweepPath: fx.sweepPath,
    sidecarPath: fx.sidecarPath,
    cursorPath: fx.cursorPath,
    lockPath: fx.lockPath,
    logPath: fx.logPath,
    batch: 3,
    healthCheck: healthUp,
    repair: rep.fn,
  };

  const r1 = await runDrain(opts);
  assert.equal(r1.exitCode, 0);
  assert.equal(r1.reason, "drained");
  assert.equal(r1.drained, 3);
  assert.deepEqual(rep.calls, [["f1", "f2", "f3"]]);
  assert.equal(readCursor(fx.cursorPath).offset, fx.offsets[2],
    "cursor must equal the byte offset immediately after row 3");

  const r2 = await runDrain(opts);
  assert.equal(r2.exitCode, 0);
  assert.equal(r2.drained, 2);
  assert.deepEqual(rep.calls[1], ["f4", "f5"]);
  assert.equal(readCursor(fx.cursorPath).offset, fx.offsets[4],
    "cursor must equal the full sweep size after run 2");

  // Third run: nothing left — clean no-op, cursor unchanged.
  const r3 = await runDrain(opts);
  assert.equal(r3.exitCode, 0);
  assert.equal(r3.reason, "nothing-to-drain");
  assert.equal(rep.calls.length, 2, "repair must not be called with an empty batch");

  // Sweep stays read-only: byte-identical after all runs.
  assert.equal(readFileSync(fx.sweepPath, "utf8"), fx.sweepBody,
    "drainer must never write the sweep file");

  // Structured log: ISO timestamps + counts.
  const recs = readLogRecords(fx.logPath);
  assert.ok(recs.length >= 3, "each run must append a log record");
  for (const rec of recs) {
    assert.match(rec.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      "log records carry ISO timestamps");
  }
  const drainedRec = recs.find((r) => r.reason === "drained");
  assert.equal(drainedRec.drained, 3);
  assert.equal(drainedRec.offset_before, 0);
  assert.equal(drainedRec.offset_after, fx.offsets[2]);
  assert.equal(drainedRec.skipped_malformed, 0);
  assert.equal(drainedRec.failed, 0);
});

// ---------------------------------------------------------------------------
// (b) Server down: cursor byte-identical, repair uncalled, exit 0.
// ---------------------------------------------------------------------------
test("server-down run is a no-op: cursor byte-identical, repair uncalled", async () => {
  const fx = makeFixture(["f1", "f2", "f3"].map(sweepRow));
  const rep = recordingRepair(fx);
  const opts = {
    sweepPath: fx.sweepPath,
    sidecarPath: fx.sidecarPath,
    cursorPath: fx.cursorPath,
    lockPath: fx.lockPath,
    logPath: fx.logPath,
    batch: 2,
    healthCheck: healthUp,
    repair: rep.fn,
  };

  // Seed a real cursor with one healthy run.
  await runDrain(opts);
  const cursorBytesBefore = readFileSync(fx.cursorPath);

  const down = await runDrain({ ...opts, healthCheck: healthDown });
  assert.equal(down.exitCode, 0);
  assert.equal(down.reason, "server-down");
  assert.deepEqual(readFileSync(fx.cursorPath), cursorBytesBefore,
    "cursor must be byte-identical after a server-down run");
  assert.equal(rep.calls.length, 1, "repair must not run while the server is down");
  const recs = readLogRecords(fx.logPath);
  assert.ok(recs.some((r) => r.reason === "server-down"), "no-op reason logged");

  // Server down with NO pre-existing cursor: none may be created.
  const fx2 = makeFixture(["g1"].map(sweepRow));
  const rep2 = recordingRepair(fx2);
  const down2 = await runDrain({
    sweepPath: fx2.sweepPath,
    sidecarPath: fx2.sidecarPath,
    cursorPath: fx2.cursorPath,
    lockPath: fx2.lockPath,
    logPath: fx2.logPath,
    batch: 2,
    healthCheck: healthDown,
    repair: rep2.fn,
  });
  assert.equal(down2.exitCode, 0);
  assert.equal(existsSync(fx2.cursorPath), false, "no cursor may be created on a down run");
  assert.equal(rep2.calls.length, 0);
});

// ---------------------------------------------------------------------------
// (c) Lockfile: a live lock makes runDrain a no-op; a stale-pid lock is
// reclaimed and the run proceeds.
// ---------------------------------------------------------------------------
test("live lockfile prevents a concurrent drain; stale-pid lock is reclaimed", async () => {
  const fx = makeFixture(["f1", "f2"].map(sweepRow));
  const rep = recordingRepair(fx);
  const opts = {
    sweepPath: fx.sweepPath,
    sidecarPath: fx.sidecarPath,
    cursorPath: fx.cursorPath,
    lockPath: fx.lockPath,
    logPath: fx.logPath,
    batch: 10,
    healthCheck: healthUp,
    repair: rep.fn,
  };

  // Live lock: our own pid IS alive, mtime is fresh -> contention no-op.
  writeFileSync(fx.lockPath,
    JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }),
    { mode: 0o600 });
  const contended = await runDrain(opts);
  assert.equal(contended.exitCode, 0);
  assert.equal(contended.reason, "lock-contention");
  assert.equal(rep.calls.length, 0, "repair must not run under contention");
  assert.equal(existsSync(fx.cursorPath), false, "no cursor read/advance under contention");
  assert.ok(existsSync(fx.lockPath), "the other holder's lock must be left in place");
  assert.ok(readLogRecords(fx.logPath).some((r) => r.reason === "lock-contention"));

  // Stale lock: dead pid -> reclaimed, drain proceeds, lock released after.
  writeFileSync(fx.lockPath,
    JSON.stringify({ pid: DEAD_PID, ts: new Date().toISOString() }),
    { mode: 0o600 });
  const reclaimed = await runDrain(opts);
  assert.equal(reclaimed.exitCode, 0);
  assert.equal(reclaimed.reason, "drained");
  assert.deepEqual(rep.calls, [["f1", "f2"]]);
  assert.equal(existsSync(fx.lockPath), false, "lock must be released after the run");
});

// ---------------------------------------------------------------------------
// (d) Malformed middle row: skipped + logged, its bytes are consumed by the
// cursor advance, and both neighbors still reach repair.
// ---------------------------------------------------------------------------
test("malformed row is skipped, logged, and the cursor advances past it", async () => {
  const fx = makeFixture([sweepRow("f1"), "THIS IS NOT JSON {", sweepRow("f2")]);
  const rep = recordingRepair(fx);
  const res = await runDrain({
    sweepPath: fx.sweepPath,
    sidecarPath: fx.sidecarPath,
    cursorPath: fx.cursorPath,
    lockPath: fx.lockPath,
    logPath: fx.logPath,
    batch: 10,
    healthCheck: healthUp,
    repair: rep.fn,
  });
  assert.equal(res.exitCode, 0);
  assert.equal(res.skippedMalformed, 1);
  assert.deepEqual(rep.calls, [["f1", "f2"]], "both neighbors must reach repair");
  assert.equal(readCursor(fx.cursorPath).offset, fx.offsets[2],
    "cursor must advance past the malformed bytes too");
  const recs = readLogRecords(fx.logPath);
  assert.ok(recs.some((r) => r.event === "malformed-line"), "malformed line logged");
  const summary = recs.find((r) => r.reason === "drained");
  assert.equal(summary.skipped_malformed, 1);
});

// ---------------------------------------------------------------------------
// (e) Dedupe: duplicate fact_ids within a batch reach repair exactly once,
// while every duplicate row's bytes are consumed.
// ---------------------------------------------------------------------------
test("duplicate fact_ids within a batch reach repair once", async () => {
  const fx = makeFixture([sweepRow("f1"), sweepRow("f1"), sweepRow("f2"), sweepRow("f1")]);
  const rep = recordingRepair(fx);
  const res = await runDrain({
    sweepPath: fx.sweepPath,
    sidecarPath: fx.sidecarPath,
    cursorPath: fx.cursorPath,
    lockPath: fx.lockPath,
    logPath: fx.logPath,
    batch: 10,
    healthCheck: healthUp,
    repair: rep.fn,
  });
  assert.equal(res.exitCode, 0);
  assert.deepEqual(rep.calls, [["f1", "f2"]], "distinct ids only, in first-seen order");
  assert.equal(readCursor(fx.cursorPath).offset, fx.offsets[3],
    "duplicate rows are consumed by the cursor");
});

// ---------------------------------------------------------------------------
// (f) Self-heal: a cursor offset beyond the sweep size resets to 0.
// ---------------------------------------------------------------------------
test("cursor offset beyond the sweep size self-heals to 0", async () => {
  const fx = makeFixture(["f1", "f2"].map(sweepRow));
  writeFileSync(fx.cursorPath, JSON.stringify({ offset: 999_999 }) + "\n", { mode: 0o600 });
  const rep = recordingRepair(fx);
  const res = await runDrain({
    sweepPath: fx.sweepPath,
    sidecarPath: fx.sidecarPath,
    cursorPath: fx.cursorPath,
    lockPath: fx.lockPath,
    logPath: fx.logPath,
    batch: 10,
    healthCheck: healthUp,
    repair: rep.fn,
  });
  assert.equal(res.exitCode, 0);
  assert.equal(res.offsetBefore, 0, "offset self-heals to 0 before the scan");
  assert.deepEqual(rep.calls, [["f1", "f2"]]);
  assert.equal(readCursor(fx.cursorPath).offset, fx.offsets[1]);
});

// ---------------------------------------------------------------------------
// Repair failure: cursor untouched, exit 1 (redo is idempotent — the real
// child's loadDoneIds skips already-embedded ids on the retry).
// ---------------------------------------------------------------------------
test("repair failure leaves the cursor untouched and exits 1", async () => {
  const fx = makeFixture(["f1", "f2", "f3"].map(sweepRow));
  const goodRep = recordingRepair(fx);
  const opts = {
    sweepPath: fx.sweepPath,
    sidecarPath: fx.sidecarPath,
    cursorPath: fx.cursorPath,
    lockPath: fx.lockPath,
    logPath: fx.logPath,
    batch: 1,
    healthCheck: healthUp,
    repair: goodRep.fn,
  };
  await runDrain(opts); // consume row 1, seed the cursor
  const cursorBytesBefore = readFileSync(fx.cursorPath);

  const failing = await runDrain({
    ...opts,
    repair: async () => ({ ok: false, exitCode: 1, detail: "CONTEXTUAL dense: retarget detected" }),
  });
  assert.equal(failing.exitCode, 1);
  assert.equal(failing.reason, "repair-failed");
  assert.equal(failing.failed, 1);
  assert.deepEqual(readFileSync(fx.cursorPath), cursorBytesBefore,
    "cursor must not advance on repair failure");
  const recs = readLogRecords(fx.logPath);
  const failRec = recs.find((r) => r.reason === "repair-failed");
  assert.equal(failRec.failed, 1);
  assert.ok(existsSync(fx.lockPath) === false, "lock released even on failure");
});

// ---------------------------------------------------------------------------
// (g) Atomic cursor write leaves no *.tmp.* residue next to the cursor.
// ---------------------------------------------------------------------------
test("no *.tmp.* residue next to the cursor after runs", async () => {
  const fx = makeFixture(["f1", "f2", "f3", "f4"].map(sweepRow));
  const rep = recordingRepair(fx);
  const opts = {
    sweepPath: fx.sweepPath,
    sidecarPath: fx.sidecarPath,
    cursorPath: fx.cursorPath,
    lockPath: fx.lockPath,
    logPath: fx.logPath,
    batch: 2,
    healthCheck: healthUp,
    repair: rep.fn,
  };
  await runDrain(opts);
  await runDrain(opts);
  const residue = readdirSync(join(fx.dir, "policy")).filter((n) => /\.tmp\./.test(n));
  assert.deepEqual(residue, [], "atomic write must clean up its tmp files");
});

// ===========================================================================
// R7 THROTTLE — the child argv seam.
//
// Every test above injects `repair`, so before buildRepairChildArgs existed
// the REAL spawn arguments were covered by nothing. These cases assert them
// directly. The argv matters more than usual here: reembed-drain.mjs is
// respawned from the working tree by launchd every StartInterval=900s with
// KeepAlive=false, so a bad argv goes live unreviewed within 15 minutes.
// ===========================================================================

// The argv EXACTLY as it was before the throttle landed. Frozen here so the
// kill-switch assertion is a byte-identical comparison against a literal,
// not a comparison against whatever the code currently happens to build.
function preThrottleArgv(idsFile) {
  return ["--max-old-space-size=8192", join("mcp", "scripts", "reembed-local-4096.mjs"), "--ids-file", idsFile];
}

const IDS_FILE = "/tmp/auto-drain-test/ids.txt";

// ---------------------------------------------------------------------------
// (a) The default (throttle ON) argv carries --ids-file AND both throttle
//     flags, with the derived defaults.
// ---------------------------------------------------------------------------
test("buildRepairChildArgs passes --ids-file and the throttle flags", () => {
  const argv = buildRepairChildArgs({ idsFile: IDS_FILE, env: {} });

  assert.ok(argv.includes("--ids-file"), "argv must carry --ids-file");
  assert.equal(argv[argv.indexOf("--ids-file") + 1], IDS_FILE,
    "--ids-file must be followed by the ids-file path");

  assert.ok(argv.includes("--batch-texts"), "argv must carry --batch-texts");
  assert.ok(argv.includes("--pause-ms"), "argv must carry --pause-ms");
  // N=16: the largest value that both bounds the server forward pass
  // (16 * 2048 padded tokens) and keeps a 1000-fact batch's request count
  // (67, measured) under EMBED_RECYCLE_AFTER_REQUESTS=128.
  assert.equal(argv[argv.indexOf("--batch-texts") + 1], "16");
  assert.equal(argv[argv.indexOf("--pause-ms") + 1], "250");

  // Flag values are strings — an argv element must never be a number.
  for (const a of argv) assert.equal(typeof a, "string", "every argv element is a string");

  // The script itself is still the proven one, spawned by relative path.
  assert.equal(argv[1], join("mcp", "scripts", "reembed-local-4096.mjs"));
});

// ---------------------------------------------------------------------------
// (b) The argv carries NONE of the prohibited flags, and the guard that
//     enforces that actually runs over the assembled argv — including the
//     value slots, which is the only way a prohibited flag could arrive.
// ---------------------------------------------------------------------------
test("assembled argv contains no prohibited flag, and the guard is load-bearing", () => {
  const prohibited = ["--build-hnsw", "--contextual", "--slice"];

  for (const env of [{}, { REEMBED_THROTTLE: "0" }, { REEMBED_BATCH_TEXTS: "8", REEMBED_PAUSE_MS: "50" }]) {
    const argv = buildRepairChildArgs({ idsFile: IDS_FILE, env });
    for (const bad of prohibited) {
      assert.ok(!argv.includes(bad),
        `argv must never contain ${bad} (env=${JSON.stringify(env)})`);
    }
  }

  // Load-bearing proof: force a prohibited token into the one slot the
  // validator does not police — the ids-file path — and the guard must reject
  // the assembled argv rather than spawn it.
  for (const bad of prohibited) {
    assert.throws(
      () => buildRepairChildArgs({ idsFile: bad, env: {} }),
      /prohibited child arg: --/,
      `the guard must reject an assembled argv containing ${bad}`,
    );
  }

  // --slice specifically: a sliced child exits 0 half-drained while this
  // drainer advances the cursor on exit 0 alone, which would strand ids
  // silently. It is also the flag that kickstarts the embed server.
  assert.throws(() => buildRepairChildArgs({ idsFile: "--slice", env: {} }), /--slice/);
});

// ---------------------------------------------------------------------------
// (c) KILL SWITCH: REEMBED_THROTTLE=0 restores the byte-identical pre-change
//     argv. Asserted, not claimed in a comment.
// ---------------------------------------------------------------------------
test("REEMBED_THROTTLE=0 restores the byte-identical pre-throttle argv", () => {
  const off = buildRepairChildArgs({ idsFile: IDS_FILE, env: { REEMBED_THROTTLE: "0" } });
  assert.deepEqual(off, preThrottleArgv(IDS_FILE),
    "the kill switch must produce the exact pre-change argv");

  // The kill switch wins over any throttle tuning that is also set.
  const offWithTuning = buildRepairChildArgs({
    idsFile: IDS_FILE,
    env: { REEMBED_THROTTLE: "0", REEMBED_BATCH_TEXTS: "8", REEMBED_PAUSE_MS: "999" },
  });
  assert.deepEqual(offWithTuning, preThrottleArgv(IDS_FILE),
    "REEMBED_THROTTLE=0 must win over REEMBED_BATCH_TEXTS/REEMBED_PAUSE_MS");

  // And it is genuinely a switch: default (unset) is ON.
  assert.notDeepEqual(buildRepairChildArgs({ idsFile: IDS_FILE, env: {} }), preThrottleArgv(IDS_FILE),
    "throttle must default ON — a default-off flag repairs nothing live");
});

// ---------------------------------------------------------------------------
// (d) Hostile env values NEVER reach the argv. An env value landing in a
//     flag's value slot is an argument-injection seam; only positive integers
//     are accepted, and everything else degrades to the default LOUDLY.
// ---------------------------------------------------------------------------
test("invalid REEMBED_BATCH_TEXTS / REEMBED_PAUSE_MS values never reach the argv", () => {
  const invalid = ["--slice", "-1", "abc", "", "--build-hnsw", "--contextual", "0", "1e3", "12.5", "-0", " "];

  for (const bad of invalid) {
    for (const key of ["REEMBED_BATCH_TEXTS", "REEMBED_PAUSE_MS"]) {
      const warnings = [];
      const argv = buildRepairChildArgs({
        idsFile: IDS_FILE,
        env: { [key]: bad },
        onWarn: (m) => warnings.push(m),
      });
      assert.ok(!argv.includes(bad) || bad === "",
        `${key}=${JSON.stringify(bad)} must not appear in the argv`);
      // The defaults survived intact.
      assert.equal(argv[argv.indexOf("--batch-texts") + 1], "16",
        `${key}=${JSON.stringify(bad)} must leave --batch-texts at its default`);
      assert.equal(argv[argv.indexOf("--pause-ms") + 1], "250",
        `${key}=${JSON.stringify(bad)} must leave --pause-ms at its default`);
      // Nothing flag-shaped can ever be an argv element beyond the known flags.
      for (const a of argv) {
        assert.ok(
          !a.startsWith("--") || ["--max-old-space-size=8192", "--ids-file", "--batch-texts", "--pause-ms"].includes(a),
          `unexpected flag-shaped argv element ${JSON.stringify(a)}`,
        );
      }
    }
  }

  // Valid values DO reach the argv — otherwise the above proves nothing.
  const good = buildRepairChildArgs({
    idsFile: IDS_FILE,
    env: { REEMBED_BATCH_TEXTS: "8", REEMBED_PAUSE_MS: "125" },
  });
  assert.equal(good[good.indexOf("--batch-texts") + 1], "8");
  assert.equal(good[good.indexOf("--pause-ms") + 1], "125");

  // The validator itself, directly.
  assert.equal(parsePositiveIntEnv(undefined, 16, "X"), 16, "unset -> default");
  assert.equal(parsePositiveIntEnv("--slice", 16, "X"), 16, "flag-shaped -> default");
  assert.equal(parsePositiveIntEnv("32", 16, "X"), 32, "positive int -> accepted");
  let warned = 0;
  parsePositiveIntEnv("abc", 16, "X", () => warned++);
  assert.equal(warned, 1, "an invalid value must be logged, not swallowed");
});

// ---------------------------------------------------------------------------
// (e) BACKLOG REPORTING: every drain log record carries sweep_size and
//     bytes_behind, and the arithmetic is exact. This number existed nowhere
//     before — the operator could not tell how far dense coverage was behind.
// ---------------------------------------------------------------------------
test("every log record carries sweep_size and bytes_behind with exact arithmetic", async () => {
  const rows = ["f1", "f2", "f3", "f4"].map(sweepRow);
  const fx = makeFixture(rows);
  const rep = recordingRepair(fx);
  const opts = {
    sweepPath: fx.sweepPath,
    sidecarPath: fx.sidecarPath,
    cursorPath: fx.cursorPath,
    lockPath: fx.lockPath,
    logPath: fx.logPath,
    batch: 2,
    healthCheck: healthUp,
    repair: rep.fn,
  };

  const sweepSize = fx.offsets[3];

  // drained
  const drained = await runDrain(opts);
  assert.equal(drained.reason, "drained");
  assert.equal(drained.sweepSize, sweepSize);
  assert.equal(drained.bytesBehind, sweepSize - 0);

  // repair-failed (cursor frozen; the backlog must still be reported)
  const failed = await runDrain({ ...opts, repair: async () => ({ ok: false, detail: "boom" }) });
  assert.equal(failed.reason, "repair-failed");
  assert.equal(failed.bytesBehind, sweepSize - fx.offsets[1]);

  // drained to completion, then nothing-to-drain (bytes_behind === 0)
  await runDrain(opts);
  const empty = await runDrain(opts);
  assert.equal(empty.reason, "nothing-to-drain");
  assert.equal(empty.bytesBehind, 0, "a fully drained sweep is 0 bytes behind");

  // no-valid-rows: a window of nothing but malformed bytes.
  const fxBad = makeFixture(["NOT JSON {", "ALSO NOT JSON ]"]);
  const noRows = await runDrain({
    sweepPath: fxBad.sweepPath,
    sidecarPath: fxBad.sidecarPath,
    cursorPath: fxBad.cursorPath,
    lockPath: fxBad.lockPath,
    logPath: fxBad.logPath,
    batch: 10,
    healthCheck: healthUp,
    repair: recordingRepair(fxBad).fn,
  });
  assert.equal(noRows.reason, "no-valid-rows");
  assert.equal(noRows.bytesBehind, fxBad.offsets[1] - 0);

  // Now the records themselves, by resolution over both logs.
  const recs = [...readLogRecords(fx.logPath), ...readLogRecords(fxBad.logPath)]
    .filter((r) => r.event === "reembed-drain");
  assert.ok(recs.length >= 5, "expected a record per run");

  const seen = new Set();
  for (const r of recs) {
    seen.add(r.reason);
    assert.ok("sweep_size" in r, `record ${r.reason} must carry sweep_size`);
    assert.ok("bytes_behind" in r, `record ${r.reason} must carry bytes_behind`);
    if (r.offset_before === null) {
      assert.equal(r.sweep_size, null);
      assert.equal(r.bytes_behind, null);
    } else {
      assert.equal(r.bytes_behind, r.sweep_size - r.offset_before,
        `bytes_behind must equal sweep_size - offset_before on a ${r.reason} record`);
      assert.ok(r.bytes_behind >= 0, "bytes_behind is never negative");
    }
  }
  for (const reason of ["drained", "repair-failed", "nothing-to-drain", "no-valid-rows"]) {
    assert.ok(seen.has(reason), `expected a ${reason} record in this run`);
  }

  // The pre-cursor no-op reasons keep the KEYS with null values: lock
  // contention must perform no cursor read at all.
  const fxLock = makeFixture([sweepRow("z1")]);
  writeFileSync(fxLock.lockPath,
    JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }), { mode: 0o600 });
  const contended = await runDrain({
    sweepPath: fxLock.sweepPath,
    sidecarPath: fxLock.sidecarPath,
    cursorPath: fxLock.cursorPath,
    lockPath: fxLock.lockPath,
    logPath: fxLock.logPath,
    batch: 5,
    healthCheck: healthUp,
    repair: recordingRepair(fxLock).fn,
  });
  assert.equal(contended.reason, "lock-contention");
  const lockRec = readLogRecords(fxLock.logPath).find((r) => r.reason === "lock-contention");
  assert.ok("sweep_size" in lockRec && "bytes_behind" in lockRec, "keys present even here");
  assert.equal(lockRec.sweep_size, null, "no cursor read under contention");
  assert.equal(lockRec.bytes_behind, null);
});

// ---------------------------------------------------------------------------
// (f) GOAL #5: a throttled batch that STILL fails must fail identically —
//     same reason, frozen cursor, exit 1 — and now additionally carry the kill
//     attribution, so the next occurrence is diagnosable from the log alone.
// ---------------------------------------------------------------------------
test("a repair failure still freezes the cursor and exits 1, now with kill attribution", async () => {
  const fx = makeFixture(["f1", "f2", "f3"].map(sweepRow));
  const good = recordingRepair(fx);
  const opts = {
    sweepPath: fx.sweepPath,
    sidecarPath: fx.sidecarPath,
    cursorPath: fx.cursorPath,
    lockPath: fx.lockPath,
    logPath: fx.logPath,
    batch: 1,
    healthCheck: healthUp,
    repair: good.fn,
  };
  await runDrain(opts);
  const cursorBytesBefore = readFileSync(fx.cursorPath);

  // The shape a real spawned repair returns when the watchdog SIGTERMs the
  // embed server mid-batch: the pid changed underneath the child.
  const failing = await runDrain({
    ...opts,
    repair: async () => ({
      ok: false,
      exitCode: 1,
      detail: "FATAL socket hang up",
      server_pid_before: 6264,
      server_pid_after: 30927,
      server_restarted_during_batch: true,
      child_last_progress: "+16 (bs=16 maxchars=812 1.9s) total=624 rate=7.1/s remaining=401",
    }),
  });

  // Unchanged failure semantics.
  assert.equal(failing.exitCode, 1);
  assert.equal(failing.reason, "repair-failed");
  assert.equal(failing.failed, 1);
  assert.deepEqual(readFileSync(fx.cursorPath), cursorBytesBefore,
    "cursor must still be frozen on failure");

  const rec = readLogRecords(fx.logPath).filter((r) => r.reason === "repair-failed").pop();
  assert.equal(rec.server_pid_before, 6264);
  assert.equal(rec.server_pid_after, 30927);
  assert.equal(rec.server_restarted_during_batch, true,
    "a pid change across the batch must be recorded");
  assert.match(rec.child_last_progress, /^\+16 \(bs=16 /,
    "the child's last progress line must survive into the record");
  assert.equal(rec.detail, "FATAL socket hang up");
  // The backlog is reported on the failing record too.
  assert.equal(rec.bytes_behind, rec.sweep_size - rec.offset_before);

  // An INJECTED repair that carries no attribution must not have any
  // fabricated for it.
  const plain = await runDrain({ ...opts, repair: async () => ({ ok: false, detail: "no attribution" }) });
  assert.equal(plain.reason, "repair-failed");
  const plainRec = readLogRecords(fx.logPath).filter((r) => r.reason === "repair-failed").pop();
  assert.equal("server_pid_before" in plainRec, false,
    "attribution must never be invented for an injected repair");
});

// ---------------------------------------------------------------------------
// The two pure parsers the attribution depends on. Hermetic: fixture strings,
// no launchctl invocation, no live process touched.
// ---------------------------------------------------------------------------
test("parseLaunchctlPid ports the embed-watchdog awk idiom; progress line is recovered", () => {
  const OUT = [
    "63481\t0\tcom.user.memory-system.embed-server",
    "-\t0\tcom.user.memory-system.embed-watchdog",
    "59796\t1\tcom.user.memory-system.reembed-drain",
  ].join("\n");

  assert.equal(parseLaunchctlPid(OUT, "com.user.memory-system.embed-server"), 63481);
  assert.equal(parseLaunchctlPid(OUT, "com.user.memory-system.reembed-drain"), 59796);
  assert.equal(parseLaunchctlPid(OUT, "com.user.memory-system.embed-watchdog"), null,
    "a not-running job ('-') is null, not a pid");
  assert.equal(parseLaunchctlPid(OUT, "com.user.memory-system.nope"), null);
  assert.equal(parseLaunchctlPid(null, "x"), null);
  // A label must match WHOLE, never as a prefix of another label.
  assert.equal(parseLaunchctlPid(OUT, "com.user.memory-system.embed"), null);

  const STDERR = [
    "--ids-file /tmp/ids.txt: 1,000 explicit ids already_embedded=124,544",
    "+16 (bs=16 maxchars=204 0.6s) total=16 rate=26.1/s remaining=1,009",
    "+16 (bs=16 maxchars=812 1.9s) total=624 rate=7.1/s remaining=401",
    "WARN embed attempt 1/8 failed (socket hang up); retry in 2000ms",
    "FATAL socket hang up",
  ].join("\n");
  assert.equal(lastChildProgressLine(STDERR),
    "+16 (bs=16 maxchars=812 1.9s) total=624 rate=7.1/s remaining=401",
    "the LAST progress line wins — it is how far the batch actually got");
  assert.equal(lastChildProgressLine("only retry noise\nFATAL socket hang up"), null);
  assert.equal(lastChildProgressLine(""), null);
  assert.equal(lastChildProgressLine(undefined), null);
});

// ===========================================================================
// R6 WORK PROOF — the cursor may only advance on MEASURED work.
//
// Before R6 `runDrain` advanced the cursor on the child's EXIT STATUS alone.
// The child can exit 0 having written nothing through several production
// doors (all-skipped non-finite vectors, the empty-chunk filter, zero rows
// resolved by collectContents), and every one of those produced a
// `drained: N` record for work that never happened.
//
// These cases are RED against the pre-R6 daemon: they were run first against
// an untouched copy of it, where the vacuous, anti-fabrication, shortfall and
// unmeasurable cases all advanced the cursor and reported `drained`.
//
// Hermetic throughout: every sidecar is a fixture file under mkdtempSync, and
// the live indices/qwen3-embedding-8b-fp16/vectors.jsonl is never opened.
// ===========================================================================

function proofOpts(fx, extra = {}) {
  return {
    sweepPath: fx.sweepPath,
    sidecarPath: fx.sidecarPath,
    cursorPath: fx.cursorPath,
    lockPath: fx.lockPath,
    logPath: fx.logPath,
    healthCheck: healthUp,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// (1) RED REPRODUCTION of r2's accident: ok:true, exitCode:0, no sidecar line,
//     no child evidence. Anti-vacuity purpose: this is the exact shape the old
//     code called "drained", so it is the one case that proves the gate exists.
// ---------------------------------------------------------------------------
test("R6: a child that exits 0 without writing a vector never advances the cursor", async () => {
  const fx = makeFixture(["f1", "f2", "f3", "f4"].map(sweepRow));
  const real = recordingRepair(fx);
  const opts = proofOpts(fx, { batch: 2, repair: real.fn });

  // A genuine drain first, so the comparison is against REAL cursor bytes.
  const good = await runDrain(opts);
  assert.equal(good.reason, "drained");
  const cursorBytesBefore = readFileSync(fx.cursorPath);

  const vac = vacuousRepair();
  const res = await runDrain({ ...opts, repair: vac.fn });

  assert.deepEqual(vac.calls, [["f3", "f4"]], "the repair really was invoked");
  assert.equal(res.drained, 0, "no work measured means no work reported");
  assert.notEqual(res.reason, "drained");
  assert.equal(res.exitCode, 1);
  assert.deepEqual(readFileSync(fx.cursorPath), cursorBytesBefore,
    "the cursor FILE must be byte-identical after a vacuous repair");

  const recs = readLogRecords(fx.logPath).filter((r) => r.event === "reembed-drain");
  assert.equal(recs.filter((r) => r.reason === "drained").length, 1,
    "only the genuine run may produce a drained record");
  assert.equal(recs.filter((r) => r.drained > 0).length, 1,
    "no record may assert drained work for the vacuous run");
  assert.equal(recs.at(-1).drained, 0);
});

// ---------------------------------------------------------------------------
// (2) ANTI-FABRICATION: the verdict is computed by the PARENT from the
//     sidecar, never read out of the repair's return value.
// ---------------------------------------------------------------------------
test("R6: a repair CLAIMING vectors_written while writing nothing is still refused", async () => {
  const fx = makeFixture(["f1", "f2"].map(sweepRow));
  const liar = vacuousRepair({ vectors_written: 99, drained: 2, work_evidence: "sidecar-tail" });
  const res = await runDrain(proofOpts(fx, { batch: 10, repair: liar.fn }));

  assert.notEqual(res.reason, "drained");
  assert.equal(res.drained, 0);
  assert.equal(res.exitCode, 1);
  assert.notEqual(res.vectorsWritten, 99, "the child's claim must never become the count");
  assert.equal(existsSync(fx.cursorPath), false, "no cursor may be created on a fabricated claim");
  const rec = readLogRecords(fx.logPath).filter((r) => r.event === "reembed-drain").at(-1);
  assert.notEqual(rec.vectors_written, 99);
  assert.equal(rec.drained, 0);
});

// ---------------------------------------------------------------------------
// (3) POSITIVE CONTROL: a genuinely successful drain is NOT stalled. Same
//     cursor byte offset the pre-R6 test asserted, plus the two proof keys.
// ---------------------------------------------------------------------------
test("R6: a repair that writes one line per id drains, with the exact pre-R6 cursor offset", async () => {
  const rows = ["f1", "f2", "f3"].map(sweepRow);
  const fx = makeFixture(rows);
  const rep = recordingRepair(fx);
  const res = await runDrain(proofOpts(fx, { batch: 3, repair: rep.fn }));

  assert.equal(res.reason, "drained");
  assert.equal(res.drained, 3);
  assert.equal(res.failed, 0);
  assert.equal(res.exitCode, 0);
  assert.equal(readCursor(fx.cursorPath).offset, fx.offsets[2],
    "the cursor lands on exactly the byte offset the pre-R6 test asserted");
  assert.equal(res.vectorsWritten, 3);
  assert.equal(res.workEvidence, "sidecar-tail");

  const rec = readLogRecords(fx.logPath).find((r) => r.reason === "drained");
  assert.equal(rec.vectors_written, 3);
  assert.equal(rec.work_evidence, "sidecar-tail");
  assert.equal(rec.drained, 3);
  assert.equal(rec.failed, 0);
});

// ---------------------------------------------------------------------------
// (4) IDEMPOTENT REDO must not stall: the child reports `pending: 0`, writes
//     nothing, and the vectors really are already in the sidecar. The parent
//     upgrades the child's word to its OWN full-scan measurement.
// ---------------------------------------------------------------------------
test("R6: an idempotent redo advances with vectors_written 0 and a full-scan label", async () => {
  const fx = makeFixture(["f1", "f2"].map(sweepRow));
  // The realistic redo state: an earlier run already embedded both ids.
  appendSidecar(fx, ["f1", "f2"]);
  const redo = vacuousRepair({
    child_work_evidence: { completed: true, embedded: 0, facts: 0, pending: 0 },
  });
  const res = await runDrain(proofOpts(fx, { batch: 10, repair: redo.fn }));

  assert.equal(res.reason, "drained", "a redo must never stall the drain");
  assert.equal(res.drained, 2);
  assert.equal(res.vectorsWritten, 0, "no NEW vector was written, and that is reported honestly");
  assert.equal(res.workEvidence, "sidecar-full-scan");
  assert.equal(readCursor(fx.cursorPath).offset, fx.offsets[1]);

  const rec = readLogRecords(fx.logPath).find((r) => r.reason === "drained");
  assert.equal(rec.work_evidence, "sidecar-full-scan");
  assert.notEqual(rec.work_evidence, "sidecar-tail",
    "a redo verification must be distinguishable in the log from a tail verification");
});

// ---------------------------------------------------------------------------
// (4b) STRANDING DETECTOR: the child claims `pending: 0` but an id in the
//      batch has no vector ANYWHERE in the sidecar. The full scan turns the
//      child's claim into a measured negative instead of a silent advance.
// ---------------------------------------------------------------------------
test("R6: pending:0 with an id that has no vector anywhere is a measured negative", async () => {
  const fx = makeFixture(["f1", "f2"].map(sweepRow));
  appendSidecar(fx, ["f1"]); // f2 was never embedded, by anyone
  const liar = vacuousRepair({
    child_work_evidence: { completed: true, embedded: 0, facts: 0, pending: 0 },
  });
  const res = await runDrain(proofOpts(fx, { batch: 10, repair: liar.fn }));

  assert.equal(res.reason, "repair-no-work");
  assert.equal(res.exitCode, 1);
  assert.equal(res.drained, 0);
  assert.equal(res.unproven, 1);
  assert.equal(res.workEvidence, "sidecar-full-scan-shortfall");
  assert.equal(existsSync(fx.cursorPath), false, "cursor frozen");
  const rec = readLogRecords(fx.logPath).filter((r) => r.event === "reembed-drain").at(-1);
  assert.deepEqual(rec.unproven_sample, ["f2"], "the record names the wedge");
});

// ===========================================================================
// R6 ROUND 2 — the routing livelock, and the controls that bound the fix.
//
// Round 1's proof was sound but its ROUTING was not: `TAIL_SHORTFALL` refused
// forever instead of asking the question a shortfall actually raises. On a
// shortfall the question is not "did THIS run write it?" but "does a vector
// exist for it AT ALL?" — which is exactly what `scanSidecarForIds` answers,
// and it was already wired for the `CHILD_ALREADY_EMBEDDED` route.
//
// The designed case that always tripped it is the already-embedded chunked
// giant (reembed-local-4096.mjs' own item-level-resume comment): chunked facts
// write ONLY `${id}#k` lines, so the child's BARE-id done-filter cannot see the
// giant and counts it in `pending`, while item-level resume writes nothing for
// it — so the tail count is 0 while `pending` is 1, forever.
//
// TWO TICKS is the assertion throughout this block. One tick cannot tell a
// stall from a slow batch; only a second tick against the same fixture can.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// (4c) PARENT-SIDE CONTROL — a child that ASSERTS remaining work and writes
//      nothing. Sidecar carries ONLY `giant#0..#2`, never a bare line, and the
//      injected child still reports `pending: 1` (the shape an OLD child, or a
//      child whose completeness count really found a chunk missing, produces).
//      The parent must refuse on BOTH ticks with the cursor never created.
// ---------------------------------------------------------------------------
test("R6: an already-embedded chunked giant STALLS LOUDLY (deliberate; residual r6-4)", async () => {
  // ORCHESTRATOR-REVERTED 2026-08-18. r6 round 2 made this case drain by routing
  // TAIL_SHORTFALL into scanSidecarForIds. That was refuted at HIGH: the scan
  // answers chunk PRESENCE, not chunk COMPLETENESS, so a fact chunked into five
  // with only `${id}#0` on disk would MATCH, the cursor would ADVANCE, and the
  // remaining four chunks would be permanently skipped. A silent permanent skip
  // is worse than a visible stall on a system whose dense coverage is ~8%.
  //
  // E3 2026-09: residual r6-4 is CLOSED IN THE CHILD — reembed-local-4096.mjs
  // planEmbedItems counts a fact complete when every chunksFor chunk id is in
  // the sidecar and reports `pending after item-level resume`, which the parent
  // prefers, so a real chunk-complete giant now arrives here as `pending: 0`
  // (see the E3 lone-giant test below). The parent-side rule did NOT change.
  // This test therefore now pins the parent REFUSING a child that CLAIMS
  // remaining work (`pending: 1`) and did none: the tail is 0 against a
  // non-zero pending, the refusal is loud — reason "repair-no-work" with an
  // unproven sample naming the id — and the cursor is frozen on every tick.
  // That is the property that keeps a wrong child count from ever advancing
  // the cursor over un-embedded ids.
  const fx = makeFixture([sweepRow("giant")]);
  appendSidecar(fx, ["giant#0", "giant#1", "giant#2"]);
  const resume = vacuousRepair({
    child_work_evidence: { completed: true, embedded: 0, facts: 0, pending: 1 },
  });
  const opts = proofOpts(fx, { batch: 10, repair: resume.fn });

  const tick1 = await runDrain(opts);
  assert.equal(tick1.reason, "repair-no-work", "the tail shortfall is the last word again");
  assert.equal(tick1.exitCode, 1);
  assert.equal(tick1.drained, 0);
  assert.equal(tick1.workEvidence, "sidecar-tail-shortfall");

  const tick2 = await runDrain(opts);
  assert.equal(tick2.reason, "repair-no-work", "two ticks: the wedge is stable, and visible");
  assert.equal(tick2.workEvidence, "sidecar-tail-shortfall");

  const recs = readLogRecords(fx.logPath).filter((r) => r.event === "reembed-drain");
  assert.deepEqual(recs.map((r) => r.reason), ["repair-no-work", "repair-no-work"]);
  assert.equal(recs[0].offset_after, recs[0].offset_before, "cursor frozen — no silent skip");
  assert.ok(Array.isArray(recs[0].unproven_sample) && recs[0].unproven_sample.includes("giant"),
    "the wedge NAMES the id, so an operator can see what is stuck");
});

// ---------------------------------------------------------------------------
// (4c-E3) THE LIVE WEDGE, AT runDrain LEVEL — chunk-complete giants plus one
//      row the child can now resolve. g1/g2/g3 exist ONLY as `${id}#k` lines
//      (2, 3 and 2 chunks); u1 has no vector. The child (E3) counts the giants
//      complete, reports `pending 1` after resume (`pending_before_resume 4`
//      from the bare-id filter), embeds u1 alone. The parent's tail counts 1
//      NEW vector, 1 === 1 reconciles at rule (2), the cursor advances past
//      all four rows and tick 2 finds nothing left. The rule that verifies is
//      the SAME rule the 599 live refusals fell through — only the child's
//      `pending` changed.
// ---------------------------------------------------------------------------
test("E3: three chunk-complete giants plus one freshly-written row drain on tick 1 and are gone on tick 2", async () => {
  const fx = makeFixture(["g1", "g2", "g3", "u1"].map(sweepRow));
  appendSidecar(fx, ["g1#0", "g1#1", "g2#0", "g2#1", "g2#2", "g3#0", "g3#1"]);
  const rep = recordingRepair(fx, {
    writeIds: (ids) => ids.filter((id) => id === "u1"),
    result: {
      child_work_evidence: { completed: true, embedded: 1, facts: 1, pending: 1, pending_before_resume: 4 },
    },
  });
  const opts = proofOpts(fx, { batch: 10, repair: rep.fn });

  const tick1 = await runDrain(opts);
  assert.equal(tick1.reason, "drained", "tick 1: the batch verifies");
  assert.equal(tick1.exitCode, 0);
  assert.equal(tick1.drained, 4, "all four rows are consumed");
  assert.equal(tick1.vectorsWritten, 1, "the parent counted exactly the ONE new vector (u1)");
  assert.equal(tick1.workEvidence, "sidecar-tail", "verified by the tail at rule (2), not by a scan");
  assert.equal(readCursor(fx.cursorPath).offset, fx.offsets[3], "cursor sits after the fourth row");
  assert.deepEqual(rep.calls, [["g1", "g2", "g3", "u1"]], "the child saw the whole batch once");

  const tick2 = await runDrain(opts);
  assert.equal(tick2.reason, "nothing-to-drain", "tick 2: the cursor MOVED, nothing is left");
  assert.equal(rep.calls.length, 1, "no second child spawn");

  const recs = readLogRecords(fx.logPath).filter((r) => r.event === "reembed-drain");
  assert.deepEqual(recs.map((r) => r.reason), ["drained", "nothing-to-drain"]);
  assert.equal(recs[0].vectors_written, 1);
  assert.equal(recs[0].work_evidence, "sidecar-tail");
  assert.equal(recs[0].offset_after, fx.offsets[3]);
  // CONTRACT PIN (found while building this test, recorded as FINDINGS FE3-4):
  // a `drained` record keeps its pre-R6 key set and carries NO attribution
  // (reembed-drain.mjs, the VERIFIED appendLog) — the child's counts, the new
  // `pending_before_resume` included, appear only on refusal records. So the
  // live self-unwedge record after E3 lands will NOT show `child_work_evidence`;
  // its signature is reason/vectors_written/work_evidence/offset_after alone.
  assert.equal("child_work_evidence" in recs[0], false,
    "a drained record carries no child attribution — unchanged by E3 (no record key added)");
});

// ---------------------------------------------------------------------------
// (4c-E3b) A LONE chunk-complete giant — the live `pending 12` shape seen on 22
//      ticks before the U+2028 row entered the batch. The E3 child counts it
//      complete and reports `pending 0` (before-resume 1); it writes nothing.
//      The tail is 0 and pending is 0, so rule (3) ROUTES to the parent's own
//      full scan, which finds `giant#k` lines for the id: verified via
//      sidecar-full-scan, cursor advances, tick 2 has nothing to drain. The
//      route is the pre-existing CHILD_ALREADY_EMBEDDED one; nothing widened.
// ---------------------------------------------------------------------------
test("E3: a lone chunk-complete giant reported pending:0 drains via the full scan on tick 1 and is gone on tick 2", async () => {
  const fx = makeFixture([sweepRow("giant")]);
  appendSidecar(fx, ["giant#0", "giant#1", "giant#2"]);
  const resume = vacuousRepair({
    child_work_evidence: { completed: true, embedded: 0, facts: 0, pending: 0, pending_before_resume: 1 },
  });
  const opts = proofOpts(fx, { batch: 10, repair: resume.fn });

  const tick1 = await runDrain(opts);
  assert.equal(tick1.reason, "drained", "tick 1: the giant is verified present");
  assert.equal(tick1.exitCode, 0);
  assert.equal(tick1.drained, 1);
  assert.equal(tick1.vectorsWritten, 0, "no NEW vector was written, and that is reported honestly");
  assert.equal(tick1.workEvidence, "sidecar-full-scan", "proved by the parent's own scan, not the child's word");
  assert.equal(readCursor(fx.cursorPath).offset, fx.offsets[0]);

  const tick2 = await runDrain(opts);
  assert.equal(tick2.reason, "nothing-to-drain", "tick 2: the cursor MOVED");

  const recs = readLogRecords(fx.logPath).filter((r) => r.event === "reembed-drain");
  assert.deepEqual(recs.map((r) => r.reason), ["drained", "nothing-to-drain"]);
  assert.equal(recs[0].work_evidence, "sidecar-full-scan");
  assert.equal(recs[0].vectors_written, 0);
  assert.equal("child_work_evidence" in recs[0], false,
    "a drained record carries no child attribution (see the FE3-4 contract pin above)");
});

// ---------------------------------------------------------------------------
// (4d) THE REALISTIC MIXED BATCH — the live 999-written/1000-pending shape, not
//      just the degenerate single-giant one. m=2, n=3, pending=3 lands on the
//      same unreconciled branch. `vectors_written` must stay the TAIL count:
//      the full scan changes the VERDICT, never the number of new writes.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// (4e) CHARACTERIZATION PIN — NOT red-first. This passed BEFORE the routing
//      fix and is pinned so nobody "fixes" a matcher that is already correct:
//      `sidecarLineId` applies `stripChunkSuffix` BEFORE the `wanted.has(id)`
//      set test, so a chunk-form line already satisfies a bare wanted id. Both
//      callers of `streamSidecarIdMatches` share that normalization, so the pin
//      covers the tail path as well as the scan path.
// ---------------------------------------------------------------------------
test("R6 (characterization, already green): the scan matches chunk-form AND bare lines", async () => {
  const fx = makeFixture([sweepRow("unused")]);

  appendSidecar(fx, ["giant#0", "giant#1", "giant#2"]);
  const chunkOnly = await scanSidecarForIds({ sidecarPath: fx.sidecarPath, ids: ["giant"] });
  assert.equal(chunkOnly.measurable, true);
  assert.deepEqual(chunkOnly.matchedIds, ["giant"], "chunk-form lines satisfy a bare wanted id");
  assert.equal(chunkOnly.unmatchedCount, 0);

  appendSidecar(fx, ["plain"]);
  const both = await scanSidecarForIds({ sidecarPath: fx.sidecarPath, ids: ["giant", "plain"] });
  assert.equal(both.matched, 2, "and the bare form still matches — no form was traded away");

  // The tail path shares sidecarLineId, so it normalizes identically.
  const sizeBefore = statSync(fx.sidecarPath).size;
  appendSidecar(fx, ["g2#0", "g2#1"]);
  const tail = await measureBatchWork({ sidecarPath: fx.sidecarPath, sizeBefore, ids: ["g2"] });
  assert.deepEqual(tail.matchedIds, ["g2"], "two chunk lines are ONE fact in the tail too");
});

// ---------------------------------------------------------------------------
// (4f) POSITIVE CONTROL — real missing work must STILL freeze the cursor. The
//      routing widening must not become an unconditional advance: f2 has no
//      vector in any form, so the full scan turns the shortfall into a MEASURED
//      negative and the cursor stays put on BOTH ticks.
// ---------------------------------------------------------------------------
test("R6: a shortfall whose id has no vector anywhere still freezes the cursor, twice", async () => {
  const fx = makeFixture(["f1", "f2"].map(sweepRow));
  appendSidecar(fx, ["f1"]); // f2 was never embedded, by anyone
  const nothing = vacuousRepair({
    child_work_evidence: { completed: true, embedded: 0, facts: 0, pending: 2 },
  });
  const opts = proofOpts(fx, { batch: 10, repair: nothing.fn });

  for (const tick of [1, 2]) {
    const res = await runDrain(opts);
    assert.equal(res.reason, "repair-no-work", `tick ${tick}: missing work is still refused`);
    assert.equal(res.exitCode, 1);
    assert.equal(res.drained, 0);
    assert.equal(res.failed, 0, "the child returned success; `failed` is not the bucket");
    assert.equal(res.unproven, 2,
      "REVERT COST (r6-4): without the full-scan narrowing the wedge names every\n       unmatched id, not just the genuinely-absent one. Less precise, still safe.");
    assert.equal(res.workEvidence, "sidecar-tail-shortfall",
      `tick ${tick}: the tail shortfall is the refusal of record again`);
    assert.equal(existsSync(fx.cursorPath), false, `tick ${tick}: cursor frozen`);
  }

  const recs = readLogRecords(fx.logPath).filter((r) => r.event === "reembed-drain");
  assert.equal(recs.length, 2);
  for (const rec of recs) {
    assert.equal(rec.offset_before, rec.offset_after, "a refusal never moves the offset");
    assert.ok(rec.unproven_sample.includes("f2"),
      "the wedge still NAMES the genuinely-absent id, which is what an operator needs");
  }
});

// ---------------------------------------------------------------------------
// (4g) EVIDENCE PRESERVATION — a TAIL_SHORTFALL routed to a full scan that
//      turns out UNMEASURABLE must keep the shortfall it ALREADY MEASURED.
//      Relabelling it `work-unmeasurable` would report LESS than we know and
//      drop `vectors_written` to null. (The `CHILD_ALREADY_EMBEDDED` route
//      keeps its downgrade — there the tail measured zero and the child's word
//      was the only evidence, so an unmeasurable scan really does leave us with
//      nothing.) Seam: a sidecar PATH that stats but cannot be streamed, so the
//      unchanged-size tail is measurable while the scan is not.
// ---------------------------------------------------------------------------
test("R6: an unmeasurable full scan does not erase an already-measured tail shortfall", async () => {
  const fx = makeFixture(["f1", "f2"].map(sweepRow));
  // Stat-able but unreadable as a stream: size never changes, so the tail is
  // MEASURABLY zero new writes, while the full scan cannot read a byte.
  const unreadable = join(fx.dir, "unreadable-sidecar.jsonl");
  mkdirSync(unreadable, { recursive: true });
  const rep = vacuousRepair({
    child_work_evidence: { completed: true, embedded: 0, facts: 0, pending: 2 },
  });
  const res = await runDrain(proofOpts(fx, { batch: 10, repair: rep.fn, sidecarPath: unreadable }));

  assert.equal(res.reason, "repair-no-work", "we measured a real shortfall; that stands");
  assert.notEqual(res.reason, "work-unmeasurable");
  assert.equal(res.workEvidence, "sidecar-tail-shortfall",
    "the evidence class names the measurement that actually happened");
  assert.equal(res.vectorsWritten, 0, "a measured zero, not a null");
  assert.equal(res.exitCode, 1);
  assert.equal(existsSync(fx.cursorPath), false, "still frozen — an unproven batch never advances");

  const rec = readLogRecords(fx.logPath).filter((r) => r.event === "reembed-drain").at(-1);
  assert.equal(rec.work_evidence, "sidecar-tail-shortfall");
  assert.equal(rec.vectors_written, 0);
  assert.notEqual(rec.vectors_written, null);
});

// ---------------------------------------------------------------------------
// (5) RECONCILED PARTIAL: 1 of 3 written, child reports pending:1. The
//     parent's independent count of NEW writes reconciles with the child's own
//     pending count, so the other two were already embedded. Advances.
// ---------------------------------------------------------------------------
test("R6: a partial write that reconciles with the child's pending count advances", async () => {
  const fx = makeFixture(["f1", "f2", "f3"].map(sweepRow));
  const rep = recordingRepair(fx, {
    writeIds: (ids) => [ids[2]], // only f3 was pending; f1/f2 came from an earlier run
    result: { child_work_evidence: { completed: true, embedded: 1, facts: 1, pending: 1 } },
  });
  const res = await runDrain(proofOpts(fx, { batch: 10, repair: rep.fn }));

  assert.equal(res.reason, "drained");
  assert.equal(res.drained, 3);
  assert.equal(res.vectorsWritten, 1, "one NEW vector, counted by the parent");
  assert.equal(res.workEvidence, "sidecar-tail");
  assert.equal(readCursor(fx.cursorPath).offset, fx.offsets[2]);
});

// ---------------------------------------------------------------------------
// (6) UNRECONCILED PARTIAL: 1 of 3 written, NO child evidence. Nothing can
//     distinguish a redo from a silent no-op, so it is refused — without
//     accusing the child of failure.
// ---------------------------------------------------------------------------
test("R6: a partial write with no child evidence is refused, not guessed at", async () => {
  const fx = makeFixture(["f1", "f2", "f3"].map(sweepRow));
  const rep = recordingRepair(fx, { writeIds: (ids) => [ids[0]] });
  const res = await runDrain(proofOpts(fx, { batch: 10, repair: rep.fn }));

  assert.notEqual(res.reason, "drained");
  assert.equal(res.drained, 0);
  assert.equal(res.exitCode, 1);
  assert.equal(res.failed, 0, "`failed` means the child returned failure; it did not");
  assert.equal(existsSync(fx.cursorPath), false, "cursor frozen");
});

// ---------------------------------------------------------------------------
// (7) UNMEASURABLE — a missing sidecar. F72: absence gets its own bucket, must
//     not advance the cursor, must not report drained, and must not report
//     `failed` either. The proof path is stat+read ONLY: it creates nothing,
//     not even the parent directory.
// ---------------------------------------------------------------------------
test("R6: a missing sidecar is unmeasurable — refused, and nothing is created", async () => {
  const fx = makeFixture(["f1", "f2"].map(sweepRow));
  const ghostDir = join(fx.dir, "no-such-index-tree");
  const ghostSidecar = join(ghostDir, "vectors.jsonl");
  const rep = vacuousRepair();
  const res = await runDrain(proofOpts(fx, {
    batch: 10,
    repair: rep.fn,
    sidecarPath: ghostSidecar,
  }));

  assert.equal(res.reason, "work-unmeasurable");
  assert.equal(res.exitCode, 1);
  assert.equal(res.drained, 0);
  assert.equal(res.failed, 0, "unmeasurable must not be reported as failure");
  assert.equal(res.unproven, null, "an unmeasurable state may not assert a count either");
  assert.equal(res.vectorsWritten, null);
  assert.equal(existsSync(fx.cursorPath), false, "cursor not written");

  assert.equal(existsSync(ghostSidecar), false, "the proof path must never create the sidecar");
  assert.equal(existsSync(ghostDir), false, "nor its parent directory");

  const rec = readLogRecords(fx.logPath).filter((r) => r.event === "reembed-drain").at(-1);
  assert.equal(rec.reason, "work-unmeasurable");
  assert.equal(rec.drained, 0);
  assert.equal(rec.failed, 0);
  assert.equal(rec.unproven, null);
  assert.equal(rec.vectors_written, null);
});

// ---------------------------------------------------------------------------
// (8) SHRUNK sidecar: truncated / rotated / replaced under us, so the tail is
//     unattributable. Unmeasurable, never verified.
// ---------------------------------------------------------------------------
test("R6: a sidecar that SHRANK across the repair is unmeasurable, not verified", async () => {
  const fx = makeFixture(["f1", "f2"].map(sweepRow));
  appendSidecar(fx, ["old1", "old2", "old3"]); // pre-existing bulk
  const shrinker = {
    calls: [],
    fn: async (ids) => {
      shrinker.calls.push([...ids]);
      truncateSync(fx.sidecarPath, 0); // rotated under us mid-batch
      appendSidecar(fx, ids);          // and re-written smaller
      return { ok: true, exitCode: 0, detail: null };
    },
  };
  const res = await runDrain(proofOpts(fx, { batch: 10, repair: shrinker.fn }));

  assert.equal(res.reason, "work-unmeasurable");
  assert.equal(res.drained, 0);
  assert.equal(res.exitCode, 1);
  assert.equal(existsSync(fx.cursorPath), false);
  assert.ok(statSync(fx.sidecarPath).size > 0, "the fixture really did shrink, not vanish");
});

// ---------------------------------------------------------------------------
// (9) CHUNK-ID: a fact chunked into `id#0` / `id#1` counts ONCE, exactly as the
//     child's own `factsWritten.add(id.replace(/#\d+$/, ""))` counts it.
// ---------------------------------------------------------------------------
test("R6: chunk-id sidecar lines count once for the bare fact id", async () => {
  const fx = makeFixture(["f1", "f2"].map(sweepRow));
  const chunked = {
    calls: [],
    fn: async (ids) => {
      chunked.calls.push([...ids]);
      appendSidecar(fx, ["f1#0", "f1#1", "f1#2", "f2#0"]);
      return { ok: true, exitCode: 0, detail: null };
    },
  };
  const res = await runDrain(proofOpts(fx, { batch: 10, repair: chunked.fn }));

  assert.equal(res.reason, "drained");
  assert.equal(res.vectorsWritten, 2, "4 chunk lines are 2 facts, not 4");
  assert.equal(res.workEvidence, "sidecar-tail");
});

// ---------------------------------------------------------------------------
// (10) KEY-ORDER: a line written `{"v":[...],"id":"..."}` is still counted, so
//      the JSON.parse fallback is live rather than decorative.
// ---------------------------------------------------------------------------
test("R6: a v-first sidecar line is still counted (the JSON.parse fallback is live)", async () => {
  const fx = makeFixture(["f1", "f2"].map(sweepRow));
  const rep = recordingRepair(fx, { vFirst: true });
  const res = await runDrain(proofOpts(fx, { batch: 10, repair: rep.fn }));

  assert.equal(res.reason, "drained");
  assert.equal(res.vectorsWritten, 2);
  // And the fixture really did produce the awkward order.
  assert.match(readFileSync(fx.sidecarPath, "utf8").split("\n")[0], /^\{"v":/);
});

// ---------------------------------------------------------------------------
// (11) parseChildWorkEvidence — the child renders BOTH lines with
//      toLocaleString(), so a `\d+` parser is wrong at n >= 1000, which is
//      exactly the live REEMBED_BATCH=1000 case.
// ---------------------------------------------------------------------------
test("parseChildWorkEvidence reads the comma-formatted child lines, and is all-null when absent", () => {
  const STDERR = [
    "--ids-file /tmp/ids.txt: 1,000 explicit ids already_embedded=124,544",
    "pending after done-filter: 1,000 facts",
    "+16 (bs=16 maxchars=204 0.6s) total=16 rate=26.1/s remaining=1,009",
    "DONE embedded=1,025 facts=1,000 in 21.4min sidecar=/opt/memory/indices/qwen3-embedding-8b-fp16/vectors.jsonl",
  ].join("\n");
  const ev = parseChildWorkEvidence(STDERR);
  assert.equal(ev.pending, 1000, "thousands separators must not truncate the count");
  assert.equal(ev.embedded, 1025);
  assert.equal(ev.facts, 1000);
  assert.equal(ev.completed, true);

  // Small (comma-free) numbers still parse.
  const small = parseChildWorkEvidence(
    "pending after done-filter: 3 facts\nDONE embedded=3 facts=3 in 0.1min sidecar=/x/v.jsonl");
  assert.equal(small.pending, 3);
  assert.equal(small.facts, 3);

  // A child that never reached the embed loop printed neither line — r2's
  // accident shape. Nothing may be inferred from that.
  for (const absent of ["", undefined, null, "WARN embed attempt 1/8 failed\nFATAL socket hang up"]) {
    assert.deepEqual(parseChildWorkEvidence(absent),
      { completed: null, embedded: null, facts: null, pending: null, pending_before_resume: null },
      `absent evidence must be all-null, not zero (input ${JSON.stringify(absent)})`);
  }

  // pending printed but the run died before DONE: pending is known, the rest is not.
  const partial = parseChildWorkEvidence("pending after done-filter: 1,000 facts\nFATAL socket hang up");
  assert.equal(partial.pending, 1000);
  assert.equal(partial.completed, false);
  assert.equal(partial.embedded, null);
  assert.equal(partial.facts, null);
});

// ---------------------------------------------------------------------------
// (11b) E3 2026-09 — the ONE line added to the child's stderr contract. The
//       live wedge at offset 7092821: the child's bare-id done-filter counted
//       13 pending (12 chunk-complete giants it could not see as done + the one
//       U+2028 row readline tore), item-level resume then wrote nothing for the
//       giants, and the parent's `m === pending` could never hold. The child
//       now also prints `pending after item-level resume`, a chunksFor
//       completeness count; `pending` prefers it. An OLD child's stderr (no
//       such line) still parses to the done-filter count, so the 599-record
//       log census stays readable by this same parser.
// ---------------------------------------------------------------------------
const OLD_CHILD_STDERR_13 = [
  "--ids-file /tmp/ids.txt: 1,000 explicit ids already_embedded=124,544",
  "pending after done-filter: 13 facts",
  "contents resolved: 12",
  "skipped 29 already-embedded chunk-ids (item-level resume)",
  "DONE embedded=0 facts=0 in 0.3min sidecar=/opt/memory/indices/qwen3-embedding-8b-fp16/vectors.jsonl",
].join("\n");

const NEW_CHILD_STDERR_13_TO_1 = [
  "--ids-file /tmp/ids.txt: 1,000 explicit ids already_embedded=124,544",
  "pending after done-filter: 13 facts",
  "contents resolved: 13",
  "skipped 29 already-embedded chunk-ids (item-level resume)",
  "pending after item-level resume: 1 facts",
  "+1 (bs=1 maxchars=4070 0.4s) total=1 rate=2.5/s remaining=0",
  "DONE embedded=1 facts=1 in 0.3min sidecar=/opt/memory/indices/qwen3-embedding-8b-fp16/vectors.jsonl",
].join("\n");

test("parseChildWorkEvidence prefers the after-resume pending count and exposes pending_before_resume", () => {
  const fresh = parseChildWorkEvidence(NEW_CHILD_STDERR_13_TO_1);
  assert.equal(fresh.pending, 1, "`pending` is the completeness count when the child prints it");
  assert.equal(fresh.pending_before_resume, 13, "the bare-id done-filter count is kept beside it");
  assert.equal(fresh.completed, true);
  assert.equal(fresh.embedded, 1);
  assert.equal(fresh.facts, 1);

  // Log-census back-compat: an old-format child yields the done-filter count
  // in BOTH keys, so nothing the census already reads changes meaning.
  const old = parseChildWorkEvidence(OLD_CHILD_STDERR_13);
  assert.equal(old.pending, 13, "old format: pending equals the done-filter count");
  assert.equal(old.pending_before_resume, 13, "old format: pending_before_resume equals it too");
  assert.equal(old.completed, true);

  // Thousands separators on the new line, same as the old one.
  const big = parseChildWorkEvidence(
    "pending after done-filter: 1,000 facts\npending after item-level resume: 1,000 facts\nFATAL socket hang up");
  assert.equal(big.pending, 1000);
  assert.equal(big.pending_before_resume, 1000);
  assert.equal(big.completed, false);

  // The new line alone (done-filter line lost) still yields a pending count
  // and an honest null for the count that was not printed.
  const only = parseChildWorkEvidence("pending after item-level resume: 2 facts");
  assert.equal(only.pending, 2);
  assert.equal(only.pending_before_resume, null);
});

// ---------------------------------------------------------------------------
// (11c) E3 HERMETIC PROOF of the LIVE shape — 1,000 batch ids, the tail
//       counted 1 NEW vector (the U+2028 row, now resolvable), the child said
//       13 before resume. classifyWorkProof is BYTE-IDENTICAL to R6; only the
//       `pending` it is handed changes, at the same rule (2) `m === pending`
//       that already trusted the child's pending. Before: unproven /
//       sidecar-tail-shortfall (the 599 live refusals). After: verified /
//       sidecar-tail.
// ---------------------------------------------------------------------------
test("E3: the live 1,000-batch / 1-written / 13-pending shape flips from tail-shortfall to verified once pending is a completeness count", () => {
  const live = { idsCount: 1000, matched: 1, measurable: true };

  const before = classifyWorkProof({ ...live, childEvidence: parseChildWorkEvidence(OLD_CHILD_STDERR_13) });
  assert.deepEqual(before, { verdict: "unproven", work_evidence: "sidecar-tail-shortfall" },
    "the wedge: 1 written against a bare-id pending of 13 is a measured negative");

  const after = classifyWorkProof({ ...live, childEvidence: parseChildWorkEvidence(NEW_CHILD_STDERR_13_TO_1) });
  assert.deepEqual(after, { verdict: "verified", work_evidence: "sidecar-tail" },
    "1 written against a completeness-counted pending of 1 reconciles at rule (2)");

  // POSITIVE CONTROL at the same rule: a completeness count that still says 2
  // against 1 written stays a measured negative — the child's line can only
  // corroborate the parent's count, never override it.
  const stillShort = classifyWorkProof({
    ...live,
    childEvidence: parseChildWorkEvidence(NEW_CHILD_STDERR_13_TO_1.replace("item-level resume: 1 facts", "item-level resume: 2 facts")),
  });
  assert.deepEqual(stillShort, { verdict: "unproven", work_evidence: "sidecar-tail-shortfall" });
});

// ---------------------------------------------------------------------------
// classifyWorkProof — the three buckets, directly. Exactly one bucket per
// input, and an unmeasurable input may never come back verified.
// ---------------------------------------------------------------------------
test("classifyWorkProof returns exactly three buckets and never verifies the unmeasurable", () => {
  const ev = (pending) => ({ completed: true, embedded: 0, facts: 0, pending });

  assert.deepEqual(classifyWorkProof({ idsCount: 3, matched: 3, measurable: true, childEvidence: null }),
    { verdict: "verified", work_evidence: "sidecar-tail" });
  assert.deepEqual(classifyWorkProof({ idsCount: 3, matched: 1, measurable: true, childEvidence: ev(1) }),
    { verdict: "verified", work_evidence: "sidecar-tail" });
  assert.deepEqual(classifyWorkProof({ idsCount: 3, matched: 0, measurable: true, childEvidence: ev(0) }),
    { verdict: "verified", work_evidence: "child-reported-already-embedded" });
  assert.deepEqual(classifyWorkProof({ idsCount: 3, matched: 1, measurable: true, childEvidence: ev(3) }),
    { verdict: "unproven", work_evidence: "sidecar-tail-shortfall" },
    "matched < pending is a MEASURED negative");
  assert.deepEqual(classifyWorkProof({ idsCount: 3, matched: 0, measurable: true, childEvidence: ev(3) }),
    { verdict: "unproven", work_evidence: "sidecar-tail-shortfall" });
  assert.deepEqual(classifyWorkProof({ idsCount: 3, matched: 1, measurable: true, childEvidence: null }),
    { verdict: "unmeasurable", work_evidence: "unmeasurable" },
    "a short count with no evidence to reconcile against is unmeasurable");
  assert.deepEqual(classifyWorkProof({ idsCount: 3, matched: 0, measurable: false, childEvidence: ev(0) }),
    { verdict: "unmeasurable", work_evidence: "unmeasurable" },
    "child evidence may never rescue an unmeasurable state");

  const buckets = new Set();
  for (const measurable of [true, false]) {
    for (const matched of [0, 1, 3]) {
      for (const childEvidence of [null, ev(0), ev(1), ev(3)]) {
        const out = classifyWorkProof({ idsCount: 3, matched, measurable, childEvidence });
        buckets.add(out.verdict);
        assert.ok(["verified", "unproven", "unmeasurable"].includes(out.verdict));
        assert.equal(typeof out.work_evidence, "string");
      }
    }
  }
  assert.deepEqual([...buckets].sort(), ["unmeasurable", "unproven", "verified"]);
});

// ---------------------------------------------------------------------------
// measureBatchWork, directly — STRICTLY READ-ONLY. A missing sidecar, a shrunk
// sidecar and an unchanged sidecar are three different answers, and none of
// them creates a file.
// ---------------------------------------------------------------------------
test("measureBatchWork is read-only and distinguishes missing / shrunk / unchanged", async () => {
  const fx = makeFixture([sweepRow("f1")]);
  const ghost = join(fx.dir, "ghost-tree", "vectors.jsonl");

  const missing = await measureBatchWork({ sidecarPath: ghost, sizeBefore: 0, ids: ["a"] });
  assert.equal(missing.measurable, false);
  assert.equal(missing.matched, 0);
  assert.equal(existsSync(ghost), false);
  assert.equal(existsSync(join(fx.dir, "ghost-tree")), false);

  // sizeBefore never captured (null) is unmeasurable, never "zero written".
  const noBaseline = await measureBatchWork({ sidecarPath: fx.sidecarPath, sizeBefore: null, ids: ["a"] });
  assert.equal(noBaseline.measurable, false);

  appendSidecar(fx, ["a", "b"]);
  const size = statSync(fx.sidecarPath).size;

  const unchanged = await measureBatchWork({ sidecarPath: fx.sidecarPath, sizeBefore: size, ids: ["a"] });
  assert.equal(unchanged.measurable, true, "an unchanged file is MEASURABLY zero new writes");
  assert.equal(unchanged.matched, 0);
  assert.equal(unchanged.unmatchedCount, 1);

  appendSidecar(fx, ["c"]);
  const grew = await measureBatchWork({ sidecarPath: fx.sidecarPath, sizeBefore: size, ids: ["c", "a"] });
  assert.equal(grew.measurable, true);
  assert.equal(grew.matched, 1, "only the TAIL counts — `a` predates sizeBefore");
  assert.deepEqual(grew.matchedIds, ["c"]);
  assert.equal(grew.unmatchedCount, 1);

  const shrunk = await measureBatchWork({ sidecarPath: fx.sidecarPath, sizeBefore: size + 10_000, ids: ["c"] });
  assert.equal(shrunk.measurable, false, "sizeAfter < sizeBefore is unattributable");

  // Read-only: the file is byte-identical after every call above.
  const bytes = readFileSync(fx.sidecarPath);
  await measureBatchWork({ sidecarPath: fx.sidecarPath, sizeBefore: 0, ids: ["a", "b", "c"] });
  assert.deepEqual(readFileSync(fx.sidecarPath), bytes, "the proof path never writes the sidecar");
});

// ---------------------------------------------------------------------------
// GOAL #5 — a fix must not report health where the old code reported failure,
// nor the reverse. The five PRE-PROOF record shapes are untouched, and none of
// them carries a proof key: the new keys exist on exactly the records that
// reached the proof step.
// ---------------------------------------------------------------------------
test("R6: the five pre-proof record shapes are unchanged and carry no proof key", async () => {
  const PROOF_KEYS = ["vectors_written", "work_evidence", "unproven", "unproven_sample"];

  // lock-contention
  const fxLock = makeFixture([sweepRow("z1")]);
  writeFileSync(fxLock.lockPath,
    JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }), { mode: 0o600 });
  const contended = await runDrain(proofOpts(fxLock, { batch: 5, repair: recordingRepair(fxLock).fn }));
  assert.equal(contended.reason, "lock-contention");
  assert.equal(contended.exitCode, 0);

  // server-down
  const fxDown = makeFixture([sweepRow("z1")]);
  const down = await runDrain(proofOpts(fxDown, {
    batch: 5, healthCheck: healthDown, repair: recordingRepair(fxDown).fn,
  }));
  assert.equal(down.reason, "server-down");
  assert.equal(down.exitCode, 0);

  // nothing-to-drain + drained (drained DOES carry the two proof keys)
  const fxOk = makeFixture([sweepRow("z1")]);
  const okOpts = proofOpts(fxOk, { batch: 5, repair: recordingRepair(fxOk).fn });
  await runDrain(okOpts);
  const empty = await runDrain(okOpts);
  assert.equal(empty.reason, "nothing-to-drain");

  // no-valid-rows
  const fxBad = makeFixture(["NOT JSON {", "ALSO NOT JSON ]"]);
  const bad = await runDrain(proofOpts(fxBad, { batch: 10, repair: recordingRepair(fxBad).fn }));
  assert.equal(bad.reason, "no-valid-rows");

  // repair-failed — still exit 1 with the cursor frozen, still no proof key
  const fxFail = makeFixture([sweepRow("z1"), sweepRow("z2")]);
  const failed = await runDrain(proofOpts(fxFail, {
    batch: 1,
    repair: async () => ({ ok: false, exitCode: 1, detail: "child retargeted to -contextual tree" }),
  }));
  assert.equal(failed.reason, "repair-failed");
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.failed, 1);
  assert.equal(existsSync(fxFail.cursorPath), false, "repair-failed still freezes the cursor");

  const all = [fxLock, fxDown, fxOk, fxBad, fxFail]
    .flatMap((fx) => readLogRecords(fx.logPath))
    .filter((r) => r.event === "reembed-drain");
  const seen = new Set();
  for (const rec of all) {
    seen.add(rec.reason);
    if (rec.reason === "drained") {
      assert.equal(rec.vectors_written, 1);
      assert.equal(rec.work_evidence, "sidecar-tail");
      assert.equal("unproven" in rec, false, "a verified record has nothing unproven");
      continue;
    }
    for (const k of PROOF_KEYS) {
      assert.equal(k in rec, false,
        `${rec.reason} never reached the proof step, so it must not carry ${k}`);
    }
    // and the pre-R6 backlog contract still holds on every one of them
    assert.ok("sweep_size" in rec && "bytes_behind" in rec);
  }
  for (const reason of ["lock-contention", "server-down", "nothing-to-drain", "no-valid-rows", "repair-failed", "drained"]) {
    assert.ok(seen.has(reason), `expected a ${reason} record`);
  }
});

// ---------------------------------------------------------------------------
// defaultSidecarPath MIRRORS the child's own derivation (env var, not a CAPS
// import), so parent and child can never disagree about which file to measure.
// ---------------------------------------------------------------------------
test("defaultSidecarPath mirrors the child's env-var derivation of the output tree", () => {
  assert.match(defaultSidecarPath({}),
    /indices\/qwen3-embedding-8b-fp16\/vectors\.jsonl$/,
    "the literal default matches the child's `|| \"qwen3-embedding-8b-fp16\"`");
  assert.match(defaultSidecarPath({ ACTIVE_EMBED_MODEL_VERSION: "some-other-model" }),
    /indices\/some-other-model\/vectors\.jsonl$/,
    "and it follows the same env var the child reads");
});

// ===========================================================================
// e1 — EMBED-POPULATION CENSUS (mcp/lib/recall/embed-population-census.js and
// mcp/scripts/verify-embed-population-census.mjs).
//
// WHY HERE. Registered-suite discipline: SUITES in mcp/scripts/run-all-tests.mjs
// is a hand-maintained literal behind a parity gate, so a new test file would
// break parity. The census is drain-adjacent by construction — it imports
// `stripChunkSuffix` / `sidecarLineId` from daemons/reembed-drain.mjs so the
// `${id}#${k}` chunk rule has EXACTLY ONE definition tree-wide.
//
// HERMETIC. Every arm builds its own mkdtemp fixture under FIXTURE_ROOT. No
// arm names ledgers/memory.jsonl, indices/<model>/*, storage/ or policy/ under
// the live tree; no arm spawns a drain, an embed server or a daemon.
//
// ARMS
//   (a) one id appended TWICE with different embed_state -> ONE id, in the
//       LAST row's bucket (latest-write-wins, not two rows counted).
//   (b) a chunked giant present in the sidecar ONLY as `${id}#0` / `#1` ->
//       counted as embedded. The arm ALSO builds the naive bare-id set that a
//       census without stripChunkSuffix would build and asserts it MISSES the
//       parent — so the arm fails if the chunk rule is dropped.
//   (c) a row with NO embed_state key and no vector -> P-UNMEASURABLE-NO-
//       EMBED-STATE, never an embedded bucket.
//   (d) a row appended AFTER the pinned eof is excluded from every count.
//   (e) an hnsw meta stamped with a DIFFERENT model -> CLI exit 3.
//   (f) an unreadable sidecar -> CLI exit 2 with a census-free payload.
//   (g) parity: stripChunkSuffix as imported by the census agrees with the
//       drain's own behaviour across a fixture table of ids.
//   (h) a meta shaped EXACTLY as HnswIndex.save() writes after
//       add(a),add(b),add(c),remove(b) — id_map 3 / nextId 3 / tombstones
//       ["b"] — is CENSUSED, not refused, and `b` is excluded from
//       P-EMBEDDED-INDEXED by SET DIFFERENCE. A parent whose `#0` entry is
//       live and `#1` entry is tombstoned STAYS indexed (presence, not
//       completeness). A tombstone that is NOT a key of id_map still refuses.
//   (i) a pinned prefix whose bytes DRIFTED under the pin is UNMEASURABLE:
//       CLI exit 2, verdict refuse, census-free payload — never a permit
//       carrying `prefix_verified: false`.
// ===========================================================================

const CENSUS_CLI = fileURLToPath(
  new URL("../scripts/verify-embed-population-census.mjs", import.meta.url),
);

let censusSeq = 0;

// One census fixture: ledger + hnsw meta + vectors.jsonl, all under mkdtemp.
// `rows` are objects appended verbatim; `idMap` / `sidecarLines` are written
// exactly as given so an arm can encode a chunked-only or ghost-id shape.
function makeCensusFixture({
  rows,
  idMap = [],
  sidecarLines = [],
  modelVersion = "fixture-model",
  // Defaulting to [] / idMap.length keeps every pre-existing arm's meta
  // BYTE-IDENTICAL to what it was before arm (h) needed these knobs.
  tombstones = [],
  nextId = undefined,
}) {
  const dir = join(FIXTURE_ROOT, `census-${censusSeq++}`);
  const indexDir = join(dir, "indices", modelVersion);
  mkdirSync(join(dir, "ledgers"), { recursive: true });
  mkdirSync(indexDir, { recursive: true });
  const ledgerPath = join(dir, "ledgers", "memory.jsonl");
  writeFileSync(ledgerPath, rows.map((r) => JSON.stringify(r) + "\n").join(""), { mode: 0o600 });
  const hnswMetaPath = join(indexDir, "hnsw.bin.meta.json");
  writeFileSync(
    hnswMetaPath,
    JSON.stringify({
      format: 2,
      backend: "hnswlib-node",
      dims: 4096,
      embedding_model_version: modelVersion,
      M: 16,
      efConstruction: 200,
      efSearch: 50,
      maxElements: 1000,
      nextId: nextId === undefined ? idMap.length : nextId,
      id_map: idMap,
      tombstones,
    }),
    { mode: 0o600 },
  );
  const sidecarPath = join(indexDir, "vectors.jsonl");
  writeFileSync(sidecarPath, sidecarLines.map((l) => l + "\n").join(""), { mode: 0o600 });
  return { dir, ledgerPath, hnswMetaPath, sidecarPath, modelVersion };
}

function censusRow(id, extra = {}) {
  return {
    id,
    kind: "fact",
    source: "codex-cli",
    created_at: "2026-07-20T03:23:29.741Z",
    provenance: { agent_id: "a", conversation_id: "c", confidence: 0.9 },
    features: {},
    ...extra,
  };
}

async function runCensus(fx, overrides = {}) {
  return censusEmbedPopulation({
    ledgerPath: fx.ledgerPath,
    hnswMetaPath: fx.hnswMetaPath,
    sidecarPath: fx.sidecarPath,
    modelVersion: fx.modelVersion,
    legacySidecarPath: null,
    sweepPath: null,
    ...overrides,
  });
}

// The CLI is a self-executing script (top-level `await main()`), so its exit
// code — the whole contract of arms (e) and (f) — is only observable from a
// child process. Env is staked at the fixture so no default can reach live data.
function runCensusCli(fx, args) {
  return spawnSync(process.execPath, [CENSUS_CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      MEMORY_ROOT: fx.dir,
      LEDGERS_BASE_DIR: join(fx.dir, "ledgers"),
      POLICY_BASE_DIR: join(fx.dir, "policy"),
      STORAGE_BASE_DIR: join(fx.dir, "storage"),
    },
  });
}

// (a) --------------------------------------------------------------------
test("census (a): a re-appended id counts ONCE, in its LAST row's bucket", async () => {
  const fx = makeCensusFixture({
    rows: [
      censusRow("mem_twice", { features: { embed_state: true } }),
      censusRow("mem_twice", { features: { embed_state: false } }),
    ],
  });
  const res = await runCensus(fx);

  assert.equal(res.population, 1, "two rows, ONE distinct id");
  assert.equal(res.instruments.ledger_predicate.rows_classified, 2, "both rows were classified");
  assert.equal(res.instruments.ledger_predicate.duplicate_id_rows, 1);
  assert.equal(res.buckets["P-EMBED-STATE-FALSE-NO-VECTOR"], 1, "the LAST row's embed_state wins");
  assert.equal(res.buckets["P-NEEDS-EMBED"], 0, "the FIRST row's embed_state does not survive");
  assert.equal(res.partition_ok, true);
  assert.equal(res.bucket_sum, res.population, "buckets partition the population exactly");
});

// (b) --------------------------------------------------------------------
test("census (b): a chunked giant is found by its `#k` vectors, and a bare-id set misses it", async () => {
  const fx = makeCensusFixture({
    rows: [censusRow("mem_giant", { features: { embed_state: false } })],
    sidecarLines: ['{"id":"mem_giant#0","v":[0.1]}', '{"id":"mem_giant#1","v":[0.1]}'],
  });
  const res = await runCensus(fx);

  assert.equal(res.buckets["P-EMBEDDED-SIDECAR-ONLY"], 1, "the chunked giant IS embedded");
  assert.equal(res.buckets["P-EMBED-STATE-FALSE-NO-VECTOR"], 0);
  assert.equal(res.instruments.vectors_sidecar.raw_lines, 2);
  assert.equal(res.instruments.vectors_sidecar.distinct_bare_ids, 1, "two chunks, ONE bare id");
  assert.equal(res.instruments.vectors_sidecar.chunked_parent_ids, 1);
  assert.equal(res.instruments.vectors_sidecar.chunk_vectors, 2);

  // The counterfactual, built here rather than asserted: a census that read the
  // sidecar `id` verbatim (no chunk rule) would hold {"mem_giant#0","mem_giant#1"}
  // and would NOT contain "mem_giant" — so it would score this row as unembedded.
  const naive = new Set(
    readFileSync(fx.sidecarPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l).id),
  );
  assert.equal(naive.has("mem_giant"), false, "a bare-id membership test undercounts the giant");
  assert.equal(naive.size, 2);

  // THE SAME TRAP ON THE OTHER INSTRUMENT. The live hnsw id_map keys chunked
  // facts by their CHUNK id (measured 2026-08-18: 8,129 of 127,235 entries),
  // so membership there is taken over BARE ids by the same imported rule. A
  // fixture indexed only as `mem_indexed_giant#0` must read as INDEXED, not as
  // an id_map entry with no ledger row.
  const fx2 = makeCensusFixture({
    rows: [censusRow("mem_indexed_giant", { features: { embed_state: false } })],
    idMap: [["mem_indexed_giant#0", 0], ["mem_indexed_giant#1", 1]],
  });
  const res2 = await runCensus(fx2);
  assert.equal(res2.buckets["P-EMBEDDED-INDEXED"], 1, "a chunk-keyed id_map entry IS the fact");
  assert.equal(res2.instruments.hnsw_id_map.id_map_entries, 2);
  assert.equal(res2.instruments.hnsw_id_map.id_map_distinct_bare_ids, 1);
  assert.equal(res2.instruments.hnsw_id_map.id_map_chunk_entries, 2);
  assert.equal(res2.instruments.hnsw_id_map.id_map_chunked_parent_ids, 1);
  assert.equal(
    res2.reconciliation.id_map_ids_without_ledger_row.count,
    0,
    "chunks of a row that IS on the ledger are not reported as orphan index entries",
  );
});

// (c) --------------------------------------------------------------------
test("census (c): no embed_state key and no vector is UNMEASURABLE, never embedded", async () => {
  const fx = makeCensusFixture({
    rows: [
      censusRow("mem_legacy_head", { features: { embedding_model_version: "gemini-embedding-001" } }),
    ],
  });
  const res = await runCensus(fx);

  assert.equal(res.buckets[UNMEASURABLE_BUCKET], 1);
  assert.equal(res.unmeasurable_bucket_shape.count, 1);
  assert.equal(res.unmeasurable_bucket_shape.is_embedded, false);
  assert.equal(res.unmeasurable_bucket_shape.by_kind.fact, 1, "its shape is reported, not just its count");
  assert.equal(res.unmeasurable_bucket_shape.by_source["codex-cli"], 1);
  assert.equal(res.buckets["P-EMBEDDED-INDEXED"], 0);
  assert.equal(res.buckets["P-EMBEDDED-SIDECAR-ONLY"], 0);
  assert.equal(res.buckets["P-NEEDS-EMBED"], 0, "an absent flag is not a pending flag");
  assert.equal(res.buckets["P-EMBED-STATE-FALSE-NO-VECTOR"], 0, "and it is not a false flag either");
  // No bucket outside the closed enum, and the unmeasurable one is in it.
  assert.deepEqual(Object.keys(res.buckets).sort(), [...EMBED_POPULATION_BUCKETS].sort());
});

// (d) --------------------------------------------------------------------
test("census (d): a row appended AFTER the pinned eof is excluded from every count", async () => {
  const fx = makeCensusFixture({
    rows: [censusRow("mem_before", { features: { embed_state: true } })],
  });
  const pinned = captureCheckpoint(fx.ledgerPath);
  assert.ok(pinned !== null && Number.isInteger(pinned.eof));

  appendFileSync(fx.ledgerPath, JSON.stringify(censusRow("mem_after", { features: { embed_state: true } })) + "\n");
  assert.ok(statSync(fx.ledgerPath).size > pinned.eof, "the fixture really did grow");

  const res = await runCensus(fx, { checkpoint: pinned });
  assert.equal(res.population, 1, "the post-pin row is not in the population");
  assert.equal(res.buckets["P-NEEDS-EMBED"], 1);
  assert.equal(res.ledger.pinned_eof, pinned.eof);
  assert.ok(
    res.ledger.bytes_beyond_pin_at_start > 0,
    "the excluded bytes past the pin are REPORTED, never absorbed",
  );
  assert.equal(res.ledger.bytes_beyond_pin_at_end, res.ledger.size_at_end - res.ledger.pinned_eof);
  assert.ok(res.ledger.size_at_end > res.ledger.pinned_eof);
  assert.equal(res.instruments.ledger_predicate.rows_classified, 1);

  // and an unpinned run over the same file DOES see it — the pin is what excludes it
  const unpinned = await runCensus(fx);
  assert.equal(unpinned.population, 2);
});

// (e) --------------------------------------------------------------------
test("census (e): an hnsw meta stamped with another model exits 3, and measures nothing", async () => {
  const fx = makeCensusFixture({
    rows: [censusRow("mem_x", { features: { embed_state: true } })],
    modelVersion: "fixture-model",
  });
  const res = runCensusCli(fx, [
    "--model-version=some-other-model",
    `--ledger=${fx.ledgerPath}`,
    `--hnsw-meta=${fx.hnswMetaPath}`,
    `--sidecar=${fx.sidecarPath}`,
  ]);
  assert.equal(res.status, 3, "a broken instrument invariant is a MEASURED-grade refusal");
  const payload = JSON.parse(res.stdout.trim());
  assert.equal(payload.verdict, "refuse");
  assert.equal(payload.measured, false);
  assert.equal(payload.error_code, "census_hnsw_model_mismatch");
  assert.equal("population" in payload, false, "a refusal carries NO census");
  assert.equal("buckets" in payload, false);

  // the library refuses identically, with a coded error rather than a degrade
  await assert.rejects(
    () => runCensus(fx, { modelVersion: "some-other-model" }),
    (err) =>
      err instanceof EmbedPopulationCensusError && err.code === "census_hnsw_model_mismatch",
  );
});

// (f) --------------------------------------------------------------------
test("census (f): an unreadable sidecar exits 2 with a census-free payload; --help too", async () => {
  const fx = makeCensusFixture({ rows: [censusRow("mem_y", { features: { embed_state: true } })] });
  const missing = join(fx.dir, "indices", fx.modelVersion, "does-not-exist.jsonl");
  const res = runCensusCli(fx, [
    `--model-version=${fx.modelVersion}`,
    `--ledger=${fx.ledgerPath}`,
    `--hnsw-meta=${fx.hnswMetaPath}`,
    `--sidecar=${missing}`,
  ]);
  assert.equal(res.status, 2, "absence is never a verdict, and never a permit");
  const payload = JSON.parse(res.stdout.trim());
  assert.equal(payload.verdict, "refuse");
  assert.equal(payload.error_code, "census_sidecar_unreadable");
  assert.equal("population" in payload, false);
  assert.equal("buckets" in payload, false);
  assert.deepEqual(payload.bucket_enum, [...EMBED_POPULATION_BUCKETS], "the enum is a contract constant");

  const help = runCensusCli(fx, ["--help"]);
  assert.equal(help.status, 2, "exit 0 is reserved for 'measured'");
  assert.equal(JSON.parse(help.stdout.trim()).verdict, "refuse");

  const unknown = runCensusCli(fx, ["--not-a-flag=1"]);
  assert.equal(unknown.status, 2);
  assert.equal(JSON.parse(unknown.stdout.trim()).error_code, "census_bad_arguments");
});

// (g) --------------------------------------------------------------------
test("census (g): the census's chunk rule IS the drain's, across a fixture table", async () => {
  const table = [
    ["mem_plain", "mem_plain"],
    ["mem_plain#0", "mem_plain"],
    ["mem_plain#12", "mem_plain"],
    ["mem_plain#0#1", "mem_plain#0"],
    ["mem_no#suffix", "mem_no#suffix"],
    ["mem_trailing#", "mem_trailing#"],
  ];
  for (const [raw, bare] of table) {
    assert.equal(stripChunkSuffix(raw), bare, `stripChunkSuffix(${raw})`);
    // sidecarLineId is the drain's own extractor and applies the SAME rule
    assert.equal(
      sidecarLineId(Buffer.from(JSON.stringify({ id: raw, v: [0.1] }))),
      bare,
      `sidecarLineId(${raw})`,
    );
  }

  // and the census's enumerating scanner agrees with both, over a real file
  const fx = makeCensusFixture({
    rows: [],
    sidecarLines: table.map(([raw]) => JSON.stringify({ id: raw, v: [0.1] })),
  });
  const scanned = await scanSidecarPopulation({ sidecarPath: fx.sidecarPath });
  const expected = new Set(table.map(([, bare]) => bare));
  assert.deepEqual([...scanned.ids].sort(), [...expected].sort());
  assert.equal(scanned.instrument.raw_lines, table.length);
  assert.equal(
    scanned.instrument.chunk_vectors,
    table.filter(([raw, bare]) => raw !== bare).length,
    "chunk vectors are counted by the SAME rule that strips them",
  );
});

// (h) --------------------------------------------------------------------
test("census (h): a tombstoned id_map is censused, and the tombstone is excluded by SET DIFFERENCE", async () => {
  // THE EXACT BYTE SHAPE HnswIndex.save() EMITS after add(a),add(b),add(c),
  // remove(b): remove() only does `this._tombstones.add(memory_id)` and NEVER
  // deletes from _idForMemoryId, so id_map keeps THREE entries while nextId
  // stays 3 and tombstones holds ["b"]. The pre-fix identity
  // (id_map.length === nextId - tombstones.length) called that "inconsistent"
  // and refused an index the writer produced by design.
  const fx = makeCensusFixture({
    rows: [
      censusRow("mem_a", { features: { embed_state: false } }),
      censusRow("mem_b", { features: { embed_state: true } }),
      censusRow("mem_c", { features: { embed_state: false } }),
    ],
    idMap: [["mem_a", 0], ["mem_b", 1], ["mem_c", 2]],
    nextId: 3,
    tombstones: ["mem_b"],
  });
  const res = await runCensus(fx);

  assert.equal(res.partition_ok, true, "the census COMPLETES over a writer-shaped tombstoned meta");
  assert.equal(res.population, 3);
  assert.equal(res.buckets["P-EMBEDDED-INDEXED"], 2, "a and c are indexed; b is NOT");
  assert.equal(res.buckets["P-NEEDS-EMBED"], 1, "the tombstoned id falls to its ledger predicate");

  // the membership set itself, not just the bucket totals
  const hnsw = readHnswMembership({ hnswMetaPath: fx.hnswMetaPath, modelVersion: fx.modelVersion });
  assert.equal(hnsw.ids.has("mem_a"), true);
  assert.equal(hnsw.ids.has("mem_c"), true);
  assert.equal(hnsw.ids.has("mem_b"), false, "a fully-tombstoned bare id is NOT live membership");

  // the deltas are PUBLISHED, never absorbed into the membership set
  assert.equal(res.instruments.hnsw_id_map.id_map_entries, 3, "the raw entry count is unchanged");
  assert.equal(res.instruments.hnsw_id_map.id_map_distinct_bare_ids, 3);
  assert.equal(res.instruments.hnsw_id_map.id_map_bare_ids_fully_tombstoned, 1);
  assert.equal(res.instruments.hnsw_id_map.id_map_bare_ids_partially_tombstoned, 0);
  assert.equal(res.instruments.hnsw_id_map.indexed_membership_bare_ids, 2);
  assert.equal(res.reconciliation.tombstoned_ids, 1);
  assert.equal(res.reconciliation.tombstoned_ids_with_ledger_row, 1);
  // the stale identity string is gone from the instrument
  assert.equal(
    /nextId - tombstones/.test(String(res.instruments.hnsw_id_map.id_map_identity_checked)),
    false,
    "the instrument no longer publishes a claim that is false about the writer",
  );

  // CHUNK SUB-CASE — presence, not completeness. p#0 live, p#1 tombstoned:
  // HnswIndex.has("p#0") is still true, so the parent is still returnable.
  const fxChunk = makeCensusFixture({
    rows: [censusRow("mem_p", { features: { embed_state: true } })],
    idMap: [["mem_p#0", 0], ["mem_p#1", 1]],
    nextId: 2,
    tombstones: ["mem_p#1"],
  });
  const resChunk = await runCensus(fxChunk);
  assert.equal(
    resChunk.buckets["P-EMBEDDED-INDEXED"],
    1,
    "a parent with ONE live chunk vector is still INDEXED — a tombstoned chunk never demotes it",
  );
  assert.equal(resChunk.instruments.hnsw_id_map.id_map_bare_ids_fully_tombstoned, 0);
  assert.equal(resChunk.instruments.hnsw_id_map.id_map_bare_ids_partially_tombstoned, 1);
  assert.equal(resChunk.instruments.hnsw_id_map.indexed_membership_bare_ids, 1);

  // GENUINE SELF-DISAGREEMENT IS STILL A REFUSAL, not a shrug.
  // (1) a tombstone that is NOT a key of id_map — remove() early-returns for
  //     an unmapped memory_id, so this meta cannot have come from the writer.
  const fxGhost = makeCensusFixture({
    rows: [censusRow("mem_a", { features: { embed_state: true } })],
    idMap: [["mem_a", 0]],
    nextId: 1,
    tombstones: ["mem_never_added"],
  });
  await assert.rejects(
    () => runCensus(fxGhost),
    (err) =>
      err instanceof EmbedPopulationCensusError && err.code === "census_hnsw_id_map_inconsistent",
  );
  // (2) id_map.length !== nextId — add() allocates exactly one id per entry.
  const fxSkew = makeCensusFixture({
    rows: [censusRow("mem_a", { features: { embed_state: true } })],
    idMap: [["mem_a", 0], ["mem_b", 1]],
    nextId: 5,
  });
  await assert.rejects(
    () => runCensus(fxSkew),
    (err) =>
      err instanceof EmbedPopulationCensusError && err.code === "census_hnsw_id_map_inconsistent",
  );
});

// (i) --------------------------------------------------------------------
test("census (i): a DRIFTED pinned prefix is UNMEASURABLE — exit 2, census-free payload", async () => {
  const rows = [];
  for (let i = 0; i < 200; i += 1) {
    rows.push(censusRow(`mem_drift_${i}`, { features: { embed_state: true } }));
  }
  const fx = makeCensusFixture({ rows });

  // Pin it, then persist the pin in the shape loadPin accepts
  // (`observation.checkpoint` — pin-ledger-snapshot.mjs's own payload shape).
  const pinned = captureCheckpoint(fx.ledgerPath);
  assert.ok(pinned !== null && Number.isInteger(pinned.eof));
  const pinPath = join(fx.dir, "pin.json");
  writeFileSync(
    pinPath,
    JSON.stringify({ observation: { checkpoint: serializeCheckpoint(pinned) } }),
    { mode: 0o600 },
  );

  // Byte offset of row 100's opening `{`, INSIDE the pinned prefix.
  let off = 0;
  for (let i = 0; i < 100; i += 1) off += Buffer.byteLength(JSON.stringify(rows[i]) + "\n", "utf8");
  assert.ok(off < pinned.eof, "the byte we drift is inside the pin, not past it");

  // ONE byte, SAME length, in place. This is a mkdtemp FIXTURE ledger — no arm
  // in this suite ever opens the live tree for write.
  const fd = openSync(fx.ledgerPath, "r+");
  try {
    writeSync(fd, Buffer.from(" "), 0, 1, off);
  } finally {
    closeSync(fd);
  }
  assert.equal(
    statSync(fx.ledgerPath).size,
    pinned.eof,
    "length is unchanged — only the CONTENT under the pin drifted",
  );

  const res = runCensusCli(fx, [
    `--model-version=${fx.modelVersion}`,
    `--ledger=${fx.ledgerPath}`,
    `--hnsw-meta=${fx.hnswMetaPath}`,
    `--sidecar=${fx.sidecarPath}`,
    `--pin=${pinPath}`,
  ]);
  assert.equal(res.status, 2, "a drifted prefix is UNMEASURABLE (2), never a permit and never 3");
  const payload = JSON.parse(res.stdout.trim());
  assert.equal(payload.verdict, "refuse");
  assert.equal(payload.measured, false);
  assert.equal(payload.error_code, "census_prefix_drifted");
  assert.equal("population" in payload, false, "a refusal carries NO census");
  assert.equal("buckets" in payload, false);
  assert.equal("partition_ok" in payload, false);

  // THIS assertion is what pins the exit code at 2 rather than 3: the CLI's
  // catch routes non-invariant codes to 2 with a census-free envelope.
  assert.equal(
    INSTRUMENT_INVARIANT_CODES.includes("census_prefix_drifted"),
    false,
    "drift is 'nothing could be measured', not 'a measured instrument invariant broke'",
  );

  // the library refuses identically, and BEFORE the 3.4 GB-class counting pass
  await assert.rejects(
    () => runCensus(fx, { checkpoint: pinned }),
    (err) =>
      err instanceof EmbedPopulationCensusError &&
      err.code === "census_prefix_drifted" &&
      err.details.phase === "pre_pass" &&
      err.details.reason === "prefix-drift",
  );
});

// ===========================================================================
// e2 — THE DERIVED WORK SET (mcp/lib/recall/embed-work-set.js, runDrain's
// `workSetMode`, and mcp/scripts/verify-embed-work-set.mjs).
//
// WHY HERE. Same registered-suite discipline as the census arms above: SUITES
// in mcp/scripts/run-all-tests.mjs is a hand-maintained literal behind a parity
// gate, so a new test/**/*.test.mjs file would break parity. These arms are
// drain arms — they drive runDrain.
//
// HERMETIC. Every arm builds its own mkdtemp fixture: its own ledger, its own
// hnsw meta, its own sweep, sidecar, cursors and log. No arm names
// ledgers/memory.jsonl, indices/<model>/*, policy/* or storage/* under the live
// tree; no arm spawns a drain, a child, an embed server or a daemon.
//
// ARMS
//   (a) RED: a fact row with features.embed_state === true whose id appears in
//       NO sweep line is INVISIBLE to a sweep-mode run and VISIBLE to a
//       ledger-mode run — the same assertion text fails before the wiring.
//   (b) a drifted pinned prefix under a stored cursor refuses
//       (work_set_prefix_drifted), cursor byte-identical, repair uncalled.
//   (c) an unreadable ledger and a model-mismatched hnsw meta each refuse with
//       their own stable code, and NEVER log `nothing-to-drain`.
//   (d) chunked giant: a fact whose only vector evidence is `${id}#0` is STILL
//       a candidate and the drain stalls loudly instead of advancing.
//   (e) default OFF: with REEMBED_WORK_SET unset every sweep-mode record is
//       key-for-key what it is today, and no work-set cursor is created.
//   (f) bounded cost: rowsScanned for a batch of N is bounded by N, not by
//       ledger size, on a ledger whose tail extends far past the cursor.
//   (g) reuse at the SYMBOL level: the work-set module's predicate IS the
//       census's function object and its chunk rule IS the drain's.
//   (h) cursor persistence: {v, offset, pin} written through the drain's ONE
//       atomic writer, resumed on the next tick, with no *.tmp.* residue.
//   (i) the operator CLI: one JSON line on every path, exit 0/2/3, and — with
//       no --commit — not one byte written.
//   (j) RED: DISTINCTNESS. A ledger that RE-APPENDS one id with
//       embed_state true yields each bare id ONCE, `duplicateRows === 1`,
//       `candidateRows === 3`, and a cursor that still advances past all three
//       rows — while the drain DRAINS instead of freezing. Fails verbatim
//       against the pre-fix `ids.push` derivation.
// ===========================================================================

import {
  WORK_SET_SHARED_SYMBOLS,
  WorkSetError,
  deriveWorkSetBatch,
  readWorkSetCursor,
  readWorkSetExclusions,
  writeWorkSetCursor,
} from "../lib/recall/embed-work-set.js";
import { readRowEmbedInputs } from "../lib/recall/embed-population-census.js";
import { writeCursorFile } from "../../daemons/reembed-drain.mjs";

// A drain fixture (sweep + sidecar + cursor + lock + log) PLUS a ledger and an
// hnsw meta, so one fixture can be driven in either mode.
function makeWorkSetFixture({
  rows = [],
  idMap = [],
  sweepLines = [],
  modelVersion = "fixture-model",
} = {}) {
  const fx = makeFixture(sweepLines);
  mkdirSync(join(fx.dir, "ledgers"), { recursive: true });
  const ledgerPath = join(fx.dir, "ledgers", "memory.jsonl");
  writeFileSync(ledgerPath, rows.map((r) => JSON.stringify(r) + "\n").join(""), { mode: 0o600 });
  const indexDir = join(fx.dir, "indices", modelVersion);
  mkdirSync(indexDir, { recursive: true });
  const hnswMetaPath = join(indexDir, "hnsw.bin.meta.json");
  writeFileSync(
    hnswMetaPath,
    JSON.stringify({
      format: 2,
      backend: "hnswlib-node",
      dims: 4096,
      embedding_model_version: modelVersion,
      maxElements: 1000,
      nextId: idMap.length,
      id_map: idMap,
      tombstones: [],
    }),
    { mode: 0o600 },
  );
  return {
    ...fx,
    ledgerPath,
    hnswMetaPath,
    modelVersion,
    workSetCursorPath: join(fx.dir, "policy", "re-embed-work-set.cursor"),
  };
}

/** A ledger row that NEEDS an embedding, in the live row shape. */
function needsEmbedRow(id, extra = {}) {
  return censusRow(id, { features: { embed_state: true }, ...extra });
}

/** A ledger row that does not (the flag says ready). */
function readyRow(id) {
  return censusRow(id, { features: { embed_state: false } });
}

function ledgerOpts(fx, extra = {}) {
  return proofOpts(fx, {
    workSetMode: "ledger",
    ledgerPath: fx.ledgerPath,
    hnswMetaPath: fx.hnswMetaPath,
    modelVersion: fx.modelVersion,
    workSetCursorPath: fx.workSetCursorPath,
    ...extra,
  });
}

function policyEntries(fx) {
  return readdirSync(join(fx.dir, "policy"));
}

// (a) --------------------------------------------------------------------
// THE RED ARM. Pre-wiring, `workSetMode` is not a thing runDrain knows about,
// so the ledger-mode call falls through to the sweep and the LAST assertion
// below fails verbatim: the derived id never reaches repair.
// ---------------------------------------------------------------------------
test("e2 (a): a row the sweep never mentioned is INVISIBLE in sweep mode and DRAINED in ledger mode", async () => {
  const fx = makeWorkSetFixture({
    rows: [needsEmbedRow("mem_never_swept"), readyRow("mem_already_ready")],
    idMap: [],
    sweepLines: [], // the queue has never heard of this fact
  });

  const sweepRepair = recordingRepair(fx);
  const sweepRun = await runDrain(proofOpts(fx, { batch: 10, repair: sweepRepair.fn }));
  assert.equal(sweepRun.reason, "nothing-to-drain", "the queue is empty, so the sweep drain idles");
  assert.deepEqual(sweepRepair.calls, [], "sweep mode cannot see a row nobody enqueued");

  const ledgerRepair = recordingRepair(fx);
  const ledgerRun = await runDrain(ledgerOpts(fx, { batch: 10, repair: ledgerRepair.fn }));
  assert.deepEqual(
    ledgerRepair.calls,
    [["mem_never_swept"]],
    "the DERIVED work set hands repair exactly the row whose own features say it needs one",
  );
  assert.equal(ledgerRun.reason, "drained");
  assert.equal(ledgerRun.exitCode, 0);
  assert.equal(ledgerRun.drained, 1);

  const rec = readLogRecords(fx.logPath)
    .filter((r) => r.event === "reembed-drain")
    .pop();
  assert.equal(rec.work_set_mode, "ledger");
  assert.equal(rec.sweep_size, null, "a ledger-mode record has no sweep backlog to report");
  assert.equal(rec.bytes_behind, null);
  assert.equal(rec.candidates, 1, "one row matched the predicate");
  assert.equal(rec.rows_scanned, 2, "and both rows were classified to find it");
  assert.equal(typeof rec.derive_ms, "number");
  assert.equal(rec.ledger_cursor_before, 0);
  assert.equal(
    rec.ledger_cursor_after,
    statSync(fx.ledgerPath).size,
    "the batch was not filled, so the WHOLE window was classified and consumed — the " +
      "early-stop advance rule is pinned by arm (f) instead",
  );
});

// (b) --------------------------------------------------------------------
test("e2 (b): a DRIFTED prefix under the stored cursor refuses and freezes the cursor", async () => {
  const fx = makeWorkSetFixture({
    rows: [needsEmbedRow("mem_aaaaaaaaaaaaaaaa"), needsEmbedRow("mem_bbbbbbbbbbbbbbbb")],
    idMap: [],
  });

  // Tick 1 drains the first row and pins the consumed prefix.
  const first = recordingRepair(fx);
  const tick1 = await runDrain(ledgerOpts(fx, { batch: 1, repair: first.fn }));
  assert.equal(tick1.reason, "drained");
  const cursorBytes = readFileSync(fx.workSetCursorPath, "utf8");
  const stored = JSON.parse(cursorBytes);
  assert.equal(stored.v, 1);
  assert.ok(stored.pin !== null && stored.pin.eof === stored.offset,
    "the pin certifies EXACTLY the prefix the cursor claims to have consumed");

  // Rewrite a byte INSIDE the consumed prefix, same length, so only the bytes
  // differ — the file's size and line structure are untouched.
  const fd = openSync(fx.ledgerPath, "r+");
  try { writeSync(fd, Buffer.from("X"), 0, 1, 9); } finally { closeSync(fd); }

  const after = recordingRepair(fx);
  const tick2 = await runDrain(ledgerOpts(fx, { batch: 1, repair: after.fn }));
  assert.equal(tick2.reason, "work-set-unmeasurable");
  assert.equal(tick2.exitCode, 1);
  assert.equal(tick2.workSetErrorCode, "work_set_prefix_drifted");
  assert.deepEqual(after.calls, [], "a derivation that could not be measured calls no repair");
  assert.equal(readFileSync(fx.workSetCursorPath, "utf8"), cursorBytes,
    "the cursor file is BYTE-IDENTICAL across the refusal");

  const reasons = readLogRecords(fx.logPath)
    .filter((r) => r.event === "reembed-drain")
    .map((r) => r.reason);
  assert.equal(reasons.includes("nothing-to-drain"), false,
    "absence is never a verdict: a drifted prefix is not an empty queue");
  assert.deepEqual(reasons, ["drained", "work-set-unmeasurable"]);
});

// (c) --------------------------------------------------------------------
test("e2 (c): an unreadable ledger and a mismatched hnsw meta refuse with distinct codes", async () => {
  const fx = makeWorkSetFixture({ rows: [needsEmbedRow("mem_cccccccccccccccc")], idMap: [] });

  const missing = recordingRepair(fx);
  const noLedger = await runDrain(
    ledgerOpts(fx, { batch: 5, repair: missing.fn, ledgerPath: join(fx.dir, "ledgers", "nope.jsonl") }),
  );
  assert.equal(noLedger.reason, "work-set-unmeasurable");
  assert.equal(noLedger.workSetErrorCode, "work_set_ledger_unreadable");
  assert.deepEqual(missing.calls, []);

  const mismatched = recordingRepair(fx);
  const wrongModel = await runDrain(
    ledgerOpts(fx, { batch: 5, repair: mismatched.fn, modelVersion: "some-other-model" }),
  );
  assert.equal(wrongModel.reason, "work-set-unmeasurable");
  assert.equal(
    wrongModel.workSetErrorCode,
    "census_hnsw_model_mismatch",
    "the census's own instrument refusal is propagated VERBATIM, not degraded into a local code",
  );
  assert.deepEqual(mismatched.calls, []);

  const reasons = readLogRecords(fx.logPath)
    .filter((r) => r.event === "reembed-drain")
    .map((r) => r.reason);
  assert.deepEqual(reasons, ["work-set-unmeasurable", "work-set-unmeasurable"]);
  assert.equal(existsSync(fx.workSetCursorPath), false, "no cursor is created by a refusal");
});

// (d) --------------------------------------------------------------------
// The chunked giant, in the derived mode: its ONLY id_map evidence is
// `giant#0`, so the BARE-ENTRY exclusion set does not hold it and it is still a
// candidate. The drain then stalls on it exactly as the sweep-mode arm above
// pins — presence is not completeness, and the fail direction is unchanged.
// ---------------------------------------------------------------------------
test("e2 (d): a chunked giant stays a CANDIDATE and stalls loudly instead of advancing", async () => {
  const fx = makeWorkSetFixture({
    rows: [needsEmbedRow("giant")],
    idMap: [["giant#0", 0]],
  });
  appendSidecar(fx, ["giant#0", "giant#1", "giant#2"]);

  const membership = readWorkSetExclusions({
    hnswMetaPath: fx.hnswMetaPath,
    modelVersion: fx.modelVersion,
  });
  assert.equal(membership.excludeIds.has("giant"), false,
    "a `#k`-only parent is NOT a bare entry, so it is never excluded from the work set");

  const resume = vacuousRepair({
    child_work_evidence: { completed: true, embedded: 0, facts: 0, pending: 1 },
  });
  const opts = ledgerOpts(fx, { batch: 10, repair: resume.fn });

  const tick1 = await runDrain(opts);
  assert.deepEqual(resume.calls, [["giant"]], "the giant IS derived as work");
  assert.equal(tick1.reason, "repair-no-work", "and the stall is the same loud one as in sweep mode");
  assert.equal(tick1.exitCode, 1);
  assert.equal(tick1.workEvidence, "sidecar-tail-shortfall");

  const tick2 = await runDrain(opts);
  assert.equal(tick2.reason, "repair-no-work", "two ticks: the wedge is stable, and visible");
  assert.equal(existsSync(fx.workSetCursorPath), false,
    "the cursor is never created, so nothing is skipped past the giant");

  const rec = readLogRecords(fx.logPath).filter((r) => r.event === "reembed-drain")[0];
  assert.equal(rec.work_set_mode, "ledger");
  assert.equal(rec.ledger_cursor_before, 0);
  assert.ok(rec.unproven_sample.includes("giant"), "the wedge NAMES the id");
});

// (e) --------------------------------------------------------------------
test("e2 (e): with REEMBED_WORK_SET unset, sweep-mode records are key-for-key what they are today", async () => {
  assert.equal(process.env.REEMBED_WORK_SET, undefined,
    "this suite runs with the gate OFF — the installed plist carries no such key either");

  const fx = makeWorkSetFixture({
    rows: [needsEmbedRow("mem_dddddddddddddddd")], // a candidate the sweep must NOT see
    sweepLines: [sweepRow("mem_from_the_queue")],
  });
  const rep = recordingRepair(fx);
  const res = await runDrain(proofOpts(fx, { batch: 10, repair: rep.fn }));
  assert.equal(res.reason, "drained");
  assert.deepEqual(rep.calls, [["mem_from_the_queue"]], "the queue, and only the queue");

  const rec = readLogRecords(fx.logPath).filter((r) => r.event === "reembed-drain")[0];
  assert.deepEqual(
    Object.keys(rec),
    [
      "ts", "event", "offset_before", "offset_after", "drained", "skipped_malformed",
      "failed", "sweep_size", "bytes_behind", "reason", "self_healed", "vectors_written",
      "work_evidence",
    ],
    "a sweep-mode `drained` record gained NO key and lost none — the operator's log shape " +
      "must not change under a change the operator could not see",
  );
  // EVERY ledger-mode-only key, including the one added when `duplicate_rows`
  // was surfaced. `modeKeys` is `{}` in sweep mode BY CONSTRUCTION, so this
  // list is the enforcement that a future key cannot leak into the operator's
  // sweep records without this arm going red.
  for (const key of [
    "work_set_mode", "ledger_cursor_before", "ledger_cursor_after", "rows_scanned",
    "candidates", "duplicate_rows", "derive_ms", "reached_eof", "excluded",
    "work_set_error_code",
  ]) {
    assert.equal(key in rec, false, `sweep-mode records carry no ${key}`);
  }
  // And the SPELLING of every value a sweep record carries is unchanged too —
  // key-for-key above, value-shape-for-value-shape here.
  assert.equal(rec.reason, "drained");
  assert.equal(rec.self_healed, false);
  assert.equal(rec.sweep_size, statSync(fx.sweepPath).size);
  assert.equal(rec.bytes_behind, statSync(fx.sweepPath).size);
  assert.equal(rec.offset_before, 0);
  assert.equal(rec.offset_after, statSync(fx.sweepPath).size);
  assert.equal(rec.drained, 1);
  assert.equal(rec.skipped_malformed, 0);
  assert.equal(rec.failed, 0);
  assert.equal(existsSync(fx.workSetCursorPath), false,
    "and nothing new is created under policy/ in the default mode");
  assert.deepEqual(
    policyEntries(fx).sort(),
    ["re-embed-sweep.cursor", "re-embed-sweep.jsonl"],
    "policy/ holds exactly what a sweep-mode drain has always put there",
  );
});

// (f) --------------------------------------------------------------------
test("e2 (f): rowsScanned is bounded by the BATCH, not by the ledger's size", async () => {
  const rows = [];
  for (let i = 0; i < 4000; i += 1) {
    rows.push(needsEmbedRow(`mem_${String(i).padStart(16, "0")}`));
  }
  const fx = makeWorkSetFixture({ rows, idMap: [] });
  const ledgerBytes = statSync(fx.ledgerPath).size;

  const derived = deriveWorkSetBatch({ ledgerPath: fx.ledgerPath, cursor: 0, batch: 5 });
  assert.equal(derived.ids.length, 5);
  assert.equal(derived.rowsScanned, 5,
    "every row here is a candidate, so finding 5 costs exactly 5 rows — never 4,000");
  assert.ok(derived.rowsScanned <= 5 * 3,
    "STATED BOUND: rowsScanned <= 3x batch when candidate density is >= 1/3");
  assert.ok(derived.bytesScanned < ledgerBytes / 100,
    `the walk consumed ${derived.bytesScanned} of ${ledgerBytes} bytes — the tail is never read`);
  assert.equal(derived.reachedEof, false);
  assert.equal(derived.nextOffset, derived.bytesScanned);

  // Resuming reads the NEXT rows, and never re-reads the consumed prefix.
  const second = deriveWorkSetBatch({
    ledgerPath: fx.ledgerPath,
    cursor: derived.nextOffset,
    pin: derived.nextPin,
    batch: 5,
  });
  assert.equal(second.pinSource, "supplied_pin");
  assert.equal(second.fromOffset, derived.nextOffset);
  assert.equal(second.ids.length, 5);
  assert.equal(
    derived.ids.filter((id) => second.ids.includes(id)).length,
    0,
    "the two batches are disjoint: the cursor is a real position, not a re-scan",
  );

  // A mid-line cursor is a REFUSAL, never a silent re-alignment.
  assert.throws(
    () => deriveWorkSetBatch({ ledgerPath: fx.ledgerPath, cursor: derived.nextOffset - 3, batch: 1 }),
    (err) => err instanceof WorkSetError && err.code === "work_set_cursor_invalid",
  );
});

// (g) --------------------------------------------------------------------
test("e2 (g): reuse is provable at the SYMBOL level, not by grepping for a literal", () => {
  assert.equal(
    WORK_SET_SHARED_SYMBOLS.readRowEmbedInputs,
    readRowEmbedInputs,
    "the work set's row predicate IS the census's function object — one definition of " +
      "`features.embed_state === true`, tree-wide",
  );
  assert.equal(
    WORK_SET_SHARED_SYMBOLS.stripChunkSuffix,
    stripChunkSuffix,
    "and its chunk rule IS the drain's `${id}#${k}` rule",
  );
  assert.equal(
    WORK_SET_SHARED_SYMBOLS.writeCursorFile,
    writeCursorFile,
    "and its cursor writer IS the drain's atomic writer — no second tmp+rename sequence",
  );

  // The predicate itself, exercised through the shared symbol: the three
  // states the work set distinguishes are the three the census distinguishes.
  assert.equal(readRowEmbedInputs({ features: { embed_state: true } }).embedState, 1);
  assert.equal(readRowEmbedInputs({ features: { embed_state: false } }).embedState, 2);
  assert.equal(readRowEmbedInputs({ features: {} }).embedState, 0);
  assert.equal(readRowEmbedInputs({ features: { embed_state: "yes" } }).embedState, 3);
});

// (h) --------------------------------------------------------------------
test("e2 (h): the work-set cursor is {v, offset, pin}, resumed next tick, with no *.tmp.* residue", async () => {
  const fx = makeWorkSetFixture({
    rows: [
      needsEmbedRow("mem_1111111111111111"),
      needsEmbedRow("mem_2222222222222222"),
      needsEmbedRow("mem_3333333333333333"),
    ],
    idMap: [["mem_2222222222222222", 0]], // already embedded as ONE complete vector
  });

  const rep = recordingRepair(fx);
  const opts = ledgerOpts(fx, { batch: 1, repair: rep.fn });

  const tick1 = await runDrain(opts);
  assert.equal(tick1.reason, "drained");
  const c1 = readWorkSetCursor(fx.workSetCursorPath);
  assert.equal(c1.present, true);
  assert.equal(c1.offset > 0, true);
  assert.equal(c1.pin.eof, c1.offset, "the persisted pin ends exactly at the persisted offset");

  const tick2 = await runDrain(opts);
  assert.equal(tick2.reason, "drained");
  assert.deepEqual(
    rep.calls,
    [["mem_1111111111111111"], ["mem_3333333333333333"]],
    "the bare id_map entry for row 2 excluded it — a COMPLETE single-vector embed is not work",
  );

  const tick3 = await runDrain(opts);
  assert.equal(tick3.reason, "nothing-to-derive",
    "a measured-empty window is its own reason, never the sweep's `nothing-to-drain`");
  assert.equal(tick3.exitCode, 0);
  const frozen = readWorkSetCursor(fx.workSetCursorPath);
  assert.equal(frozen.offset, readWorkSetCursor(fx.workSetCursorPath).offset,
    "and the cursor did not move on a tick that proved no work");

  assert.deepEqual(
    policyEntries(fx).filter((n) => n.includes(".tmp.")),
    [],
    "no tmp residue next to the new cursor",
  );

  // The writer refuses a non-integer offset rather than persisting nonsense.
  assert.throws(
    () => writeWorkSetCursor(fx.workSetCursorPath, { offset: -1 }),
    (err) => err instanceof WorkSetError && err.code === "work_set_bad_arguments",
  );
  // Fe2-1: and it refuses a pin that would silently DEGRADE to `pin: null` on
  // disk. A pinless cursor is indistinguishable from one that never ran, so the
  // next tick would skip verifyPrefix and the drift guarantee would become an
  // assumption with no record. `pin: null` passed EXPLICITLY stays legal — that
  // is the honest start state.
  const goodPin = readWorkSetCursor(fx.workSetCursorPath).pin;
  assert.notEqual(goodPin, null, "the fixture really does have a pin to corrupt");
  assert.throws(
    () => writeWorkSetCursor(fx.workSetCursorPath, { offset: 1, pin: { ...goodPin, witness: [] } }),
    (err) => err instanceof WorkSetError && err.code === "work_set_pin_uncapturable",
    "an unvalidatable pin is a REFUSAL, never a silently pinless cursor",
  );
  assert.doesNotThrow(
    () => writeWorkSetCursor(fx.workSetCursorPath, { offset: 0, pin: null }),
    "but an EXPLICIT null pin is the honest start state and is still writable",
  );
  // A corrupt cursor is a REFUSAL, not a silent restart from ledger byte 0.
  writeCursorFile(fx.workSetCursorPath, { v: 1, offset: "nope", pin: null });
  assert.throws(
    () => readWorkSetCursor(fx.workSetCursorPath),
    (err) => err instanceof WorkSetError && err.code === "work_set_cursor_invalid",
  );
});

// (i) --------------------------------------------------------------------
// The operator CLI, on the census CLI's envelope discipline: ONE line of JSON
// on every path, exit 0 permit / 3 instrument-invariant refusal / 2 nothing
// measured, and — without --commit — not a single byte written.
// ---------------------------------------------------------------------------
const WORK_SET_CLI = fileURLToPath(new URL("../scripts/verify-embed-work-set.mjs", import.meta.url));

function runWorkSetCli(fx, args) {
  return spawnSync(process.execPath, [WORK_SET_CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      MEMORY_ROOT: fx.dir,
      LEDGERS_BASE_DIR: join(fx.dir, "ledgers"),
      POLICY_BASE_DIR: join(fx.dir, "policy"),
      STORAGE_BASE_DIR: join(fx.dir, "storage"),
    },
  });
}

test("e2 (i): the CLI permits with a checkable batch, refuses with exit 2/3, and writes nothing", () => {
  const fx = makeWorkSetFixture({
    rows: [needsEmbedRow("mem_cli_candidate"), readyRow("mem_cli_ready"), needsEmbedRow("mem_cli_indexed")],
    idMap: [["mem_cli_indexed", 0]],
  });
  const baseArgs = [
    `--model-version=${fx.modelVersion}`,
    `--ledger=${fx.ledgerPath}`,
    `--hnsw-meta=${fx.hnswMetaPath}`,
    `--cursor=${fx.workSetCursorPath}`,
    "--batch=5",
  ];

  const permit = runWorkSetCli(fx, baseArgs);
  assert.equal(permit.status, 0, permit.stderr);
  const payload = JSON.parse(permit.stdout.trim());
  assert.equal(payload.verdict, "permit");
  assert.equal(payload.measured, true);
  assert.equal(payload.committed, false);
  assert.deepEqual(
    payload.id_sample,
    ["mem_cli_candidate"],
    "every printed id is independently re-checkable: embed_state true AND not a bare id_map entry",
  );
  assert.equal(payload.exclusion_set.size, 1);
  assert.equal(typeof payload.cost.derive_ms_total, "number");
  assert.equal(typeof payload.cost.peak_rss_bytes, "number");
  assert.equal(payload.cost.rows_scanned_total, 3);
  assert.ok(payload.cost.bytes_scanned_total > 0);
  assert.equal(payload.cost.drain_start_interval_seconds, 900);
  assert.equal(existsSync(fx.workSetCursorPath), false, "a dry run creates NO cursor");
  assert.deepEqual(policyEntries(fx).filter((n) => n.includes(".tmp.")), []);

  // exit 3 — a measured instrument invariant broke (the census's own refusal).
  const mismatch = runWorkSetCli(fx, [...baseArgs.slice(1), "--model-version=some-other-model"]);
  assert.equal(mismatch.status, 3);
  const mp = JSON.parse(mismatch.stdout.trim());
  assert.equal(mp.verdict, "refuse");
  assert.equal(mp.measured, false);
  assert.equal(mp.error_code, "census_hnsw_model_mismatch");
  assert.equal("batches" in mp, false, "a refusal carries NO work set");

  // exit 2 — nothing could be measured.
  const noLedger = runWorkSetCli(fx, [...baseArgs, `--ledger=${join(fx.dir, "ledgers", "gone.jsonl")}`]);
  assert.equal(noLedger.status, 2);
  assert.equal(JSON.parse(noLedger.stdout.trim()).error_code, "work_set_ledger_unreadable");

  const help = runWorkSetCli(fx, ["--help"]);
  assert.equal(help.status, 2, "exit 0 means MEASURED — usage is not a measurement");
  assert.equal(JSON.parse(help.stdout.trim()).verdict, "refuse");

  assert.equal(existsSync(fx.workSetCursorPath), false, "not one refusal created a cursor either");
});

// (j) --------------------------------------------------------------------
// THE DISTINCTNESS RED ARM. `daemons/reembed-drain.mjs`'s `collectBatch` is
// documented as "gathering up to `batch` DISTINCT fact_ids" and collects into a
// `new Set()`. `deriveWorkSetBatch` copied its BYTE-accounting rule and dropped
// its DISTINCTNESS rule: a plain array with `ids.push`. Downstream,
// `measureBatchWork` / `classifyWorkProof` compare that array's LENGTH against
// a Set-based matched count, so a repeated id can NEVER reconcile — the tick
// ends `work-unmeasurable`, the cursor freezes, and the repair child is
// re-spawned every 900 s forever.
//
// The ledger is APPEND-ONLY and a re-append is legal, so this is a live shape,
// not a synthetic one: e1 measured `duplicate_id_rows: 0` TODAY, which is a
// measurement about this instant and never a guarantee about the next append.
//
// RED, CAPTURED NOT PREDICTED (2026-08-19). With the shipped `seenBare` block
// in `deriveWorkSetBatch` replaced by the pre-fix `ids.push(row.id)`, this arm
// fails at its first assertion. VERBATIM, from
// `node --test --test-name-pattern="e2 \(j\)" mcp/test/auto-drain.test.mjs`:
//
//   AssertionError [ERR_ASSERTION]: one fact is ONE candidate however many rows
//   spell it — a repeat consumes bytes without growing the batch, exactly as
//   collectBatch's Set.add does
//   + actual - expected
//
//     [
//       'mem_reappended_0001',
//       'mem_other_0002',
//   +   'mem_reappended_0001'
//     ]
//
//     actual: [ 'mem_reappended_0001', 'mem_other_0002', 'mem_reappended_0001' ],
//     expected: [ 'mem_reappended_0001', 'mem_other_0002' ],
//     operator: 'deepStrictEqual'
//
// and `duplicateRows` is `undefined` there, so the counter assertion fails too.
// The file was restored byte-identically afterwards (sha256 re-checked).
// ---------------------------------------------------------------------------
test("e2 (j): a RE-APPENDED id is ONE candidate, its bytes are still consumed, and the drain does not freeze", async () => {
  // Three rows; row 3 re-appends row 1's id, both with embed_state true.
  const fx = makeWorkSetFixture({
    rows: [
      needsEmbedRow("mem_reappended_0001"),
      needsEmbedRow("mem_other_0002"),
      needsEmbedRow("mem_reappended_0001"),
    ],
    idMap: [],
  });
  const ledgerBytes = statSync(fx.ledgerPath).size;

  const derived = deriveWorkSetBatch({ ledgerPath: fx.ledgerPath, cursor: 0, batch: 10 });

  assert.deepEqual(
    derived.ids,
    ["mem_reappended_0001", "mem_other_0002"],
    "one fact is ONE candidate however many rows spell it — a repeat consumes bytes without " +
      "growing the batch, exactly as collectBatch's Set.add does",
  );
  assert.equal(derived.duplicateRows, 1, "and the repeat is COUNTED, not silently absorbed");
  assert.equal(
    derived.candidateRows,
    3,
    "candidateRows counts ROWS matching the predicate — all three did; it is not the id count",
  );
  assert.equal(derived.rowsScanned, 3);
  assert.equal(derived.excluded, 0);
  assert.equal(
    derived.candidateRows - derived.duplicateRows - derived.excluded,
    derived.ids.length,
    "the counters are an ARITHMETIC IDENTITY, not four independent tallies",
  );

  // THE BYTES ARE STILL CONSUMED. The duplicate row is not a candidate, but the
  // cursor must move past it or the next tick re-reads it forever.
  assert.equal(derived.reachedEof, true);
  assert.equal(
    derived.nextOffset,
    ledgerBytes,
    "the cursor advances past ALL THREE rows, including the duplicate's bytes",
  );
  assert.equal(derived.bytesScanned, ledgerBytes);

  // ...however the repeat is SPELLED. A `#k` chunk id is the same fact.
  const chunked = makeWorkSetFixture({
    rows: [
      needsEmbedRow("mem_reappended_0001"),
      needsEmbedRow("mem_other_0002"),
      needsEmbedRow("mem_reappended_0001#0"),
    ],
    idMap: [],
  });
  const d2 = deriveWorkSetBatch({ ledgerPath: chunked.ledgerPath, cursor: 0, batch: 10 });
  assert.deepEqual(
    d2.ids,
    ["mem_reappended_0001", "mem_other_0002"],
    "candidates are keyed on the BARE id (stripChunkSuffix), the same key space the exclusion " +
      "check uses — identity, not spelling",
  );
  assert.equal(d2.duplicateRows, 1);
  assert.equal(d2.candidateRows, 3);
  assert.equal(d2.nextOffset, statSync(chunked.ledgerPath).size);

  // THE DOWNSTREAM CONSEQUENCE, driven end to end: with the duplicate collapsed
  // the proof arithmetic reconciles and the tick DRAINS. Pre-fix it could not:
  // three ids, two distinct sidecar lines, matched < ids.length -> unmeasurable
  // work, a frozen cursor, and a child re-spawned on every 900 s tick.
  const rep = recordingRepair(fx);
  const run = await runDrain(ledgerOpts(fx, { batch: 10, repair: rep.fn }));
  assert.equal(run.reason, "drained", "a re-appended id must not be able to freeze the drain");
  assert.equal(run.exitCode, 0);
  assert.deepEqual(
    rep.calls,
    [["mem_reappended_0001", "mem_other_0002"]],
    "repair is handed each fact once — the batch the proof step can actually verify",
  );

  const rec = readLogRecords(fx.logPath).filter((r) => r.event === "reembed-drain").pop();
  assert.equal(rec.reason, "drained");
  assert.equal(rec.work_set_mode, "ledger");
  assert.equal(rec.candidates, 3, "the record reports rows matched...");
  assert.equal(rec.duplicate_rows, 1, "...AND how many of them were repeats — visible, not just returned");
  assert.equal(rec.drained, 2, "while `drained` counts the FACTS handed on");
  assert.equal(rec.ledger_cursor_before, 0);
  assert.equal(rec.ledger_cursor_after, ledgerBytes);

  const cur = readWorkSetCursor(fx.workSetCursorPath);
  assert.equal(cur.offset, ledgerBytes, "and the persisted cursor cleared all three rows");
  assert.equal(cur.pin.eof, cur.offset);
});

// ===========================================================================
// e3 — THE SWEEP QUEUE'S DISPOSITION (KEEP or RETIRE).
//
// WHY HERE. Same registered-suite discipline as the e1/e2 arms above: SUITES in
// mcp/scripts/run-all-tests.mjs is a hand-maintained literal behind a parity
// gate, so a new test/**/*.test.mjs file would break parity. These are drain
// arms — they drive runDrain and the work-set CLI.
//
// HERMETIC, like every arm above: mkdtemp fixtures only. No arm names
// ledgers/memory.jsonl, indices/<model>/*, policy/* or storage/* under the live
// tree; none spawns a drain, a child, an embed server or a daemon.
//
// WHAT e3 ASKS, AND WHICH ARM ANSWERS IT
//   The node's question #1 is "does the derived path SUBSUME the queue?". Two
//   of its disagreement cases were already pinned by e2 and are CITED, not
//   duplicated:
//     e2 (a)  a row the sweep never mentioned — invisible in sweep mode,
//             drained in ledger mode. (The queue UNDER-covers.)
//     e2 (d)  an already-embedded chunked giant — a candidate in ledger mode
//             too, stalling with `repair-no-work` / `sidecar-tail-shortfall`
//             and no cursor file. (The r6-4 stall is INHERITED, not retired.)
//   The arms below are the ones that were asserted NOWHERE:
//     (a) THE FAST-PATH CLAIM, made executable — the whole KEEP argument.
//     (b) the enqueued-but-since-embedded case: which mechanism pays for it.
//     (c) the derived predicate is CONTENT-BLIND, so it can produce candidates
//         `appendReEmbedSweep` could not — its sole call site in
//         daemons/watermark.js is guarded by `hadContent`.
//     (d) the e3 `--sweep` cost arm in mcp/scripts/verify-embed-work-set.mjs
//         agrees with the drain's own `collectBatch`, which is what licenses
//         that arm to re-state a module-private rule.
// ===========================================================================

// (a) --------------------------------------------------------------------
// THE FAST PATH, MADE EXECUTABLE. "The queue may still earn its keep as a FAST
// PATH: a freshly-failed embed is known by id immediately, where a derived set
// costs a scan to find it" is e3's own premise, and it was asserted NOWHERE —
// not in e2's arms, not in the drain's header. It is asserted here, and the
// byte-offset independence is proved rather than argued: the sweep-mode run is
// given a ledgerPath that DOES NOT EXIST, so if it drains, it provably never
// consulted the ledger and its cost cannot depend on where in the ledger the
// hot row happens to sit.
//
// THE OPERATOR CONSEQUENCE this arm pins, in the units the operator feels:
// with the installed StartInterval of 900 s, the queue re-embeds the just-
// failed fact on the NEXT tick (<= 900 s), while the derived path reaches it
// only after its cursor has walked every candidate ahead of it — here 4 ticks
// (~3,600 s) for a 4-row ledger, and on the live ledger 1,388,515 candidates
// ahead of a cursor at 0 (Fe1-1) at REEMBED_BATCH=1000 per tick.
//
// RED BEFORE GREEN (2026-08-19, captured not predicted). The counterfactual is
// RETIREMENT: add `workSetMode: "ledger"` to the queue run below, so the queue
// is gone and the derived path is all there is. The arm then fails VERBATIM,
// from `node --test --test-reporter=tap --test-name-pattern="e3 \(a\)"
// mcp/test/auto-drain.test.mjs`:
//
//   not ok 1 - e3 (a): the queue drains a DEEP id on the next tick; the derived
//   cursor must first walk to it
//     ---
//     failureType: 'testCodeFailure'
//     error: |-
//       Expected values to be strictly equal:
//       + actual - expected
//
//       + 'work-set-unmeasurable'
//       - 'drained'
//
//     expected: 'drained'
//     actual: 'work-set-unmeasurable'
//
// i.e. with no queue, a run that cannot open the ledger produces NO work at
// all and the just-failed fact waits — the queue drained it without opening
// that file. The file was restored byte-identically afterwards (sha256
// re-checked: 665f18ea6d84f5064882fe8fd473df7a10d03211a8e9e59ba95ec2de0a2f7f41).
// ---------------------------------------------------------------------------
test("e3 (a): the queue drains a DEEP id on the next tick; the derived cursor must first walk to it", async () => {
  const rows = [
    needsEmbedRow("mem_cold_000000001"),
    needsEmbedRow("mem_cold_000000002"),
    needsEmbedRow("mem_cold_000000003"),
    needsEmbedRow("mem_hot_just_failed"), // the fact that just failed to embed
  ];
  const fx = makeWorkSetFixture({
    rows,
    idMap: [],
    sweepLines: [sweepRow("mem_hot_just_failed")], // ...and was enqueued by id
  });
  // Where the hot row actually starts, in bytes, so "deep" is a number.
  const hotRowStart = Buffer.byteLength(
    rows.slice(0, 3).map((r) => JSON.stringify(r) + "\n").join(""),
    "utf8",
  );
  assert.ok(hotRowStart > 0, "the hot row really is behind three others");

  // --- THE QUEUE: ONE tick, and it never opens the ledger at all -----------
  const queueRepair = recordingRepair(fx);
  const queueRun = await runDrain(
    proofOpts(fx, {
      batch: 10,
      repair: queueRepair.fn,
      // A path that does not exist. Sweep mode must not care.
      ledgerPath: join(fx.dir, "ledgers", "this-ledger-does-not-exist.jsonl"),
    }),
  );
  assert.equal(queueRun.reason, "drained");
  assert.deepEqual(
    queueRepair.calls,
    [["mem_hot_just_failed"]],
    "ONE tick, and the id is in the child's hands — with a ledger path that could not be " +
      "opened, so the queue's cost provably does not depend on the row's ledger offset",
  );
  assert.equal(queueRun.offsetAfter, statSync(fx.sweepPath).size);
  assert.ok(
    queueRun.sweepSize < hotRowStart,
    `the whole queue is ${queueRun.sweepSize} B — smaller than the ${hotRowStart} B a derived ` +
      "walk must cross before it can even see this id",
  );

  // --- THE DERIVED PATH: the same id, four ticks later ---------------------
  const ledgerRepair = recordingRepair(fx);
  const opts = ledgerOpts(fx, { batch: 1, repair: ledgerRepair.fn });

  const t1 = await runDrain(opts);
  assert.equal(t1.reason, "drained");
  assert.deepEqual(ledgerRepair.calls, [["mem_cold_000000001"]]);
  const afterTick1 = readWorkSetCursor(fx.workSetCursorPath);
  assert.ok(
    afterTick1.offset < hotRowStart,
    `after a full tick the derived cursor is at ${afterTick1.offset}, still short of the hot ` +
      `row at ${hotRowStart} — the id is INVISIBLE to this mechanism until the walk arrives`,
  );

  await runDrain(opts);
  await runDrain(opts);
  assert.deepEqual(
    ledgerRepair.calls.map((c) => c[0]),
    ["mem_cold_000000001", "mem_cold_000000002", "mem_cold_000000003"],
    "three ticks in, the derived path has still not reached the fact that actually failed",
  );

  const t4 = await runDrain(opts);
  assert.equal(t4.reason, "drained");
  assert.deepEqual(
    ledgerRepair.calls.map((c) => c[0]),
    [
      "mem_cold_000000001",
      "mem_cold_000000002",
      "mem_cold_000000003",
      "mem_hot_just_failed",
    ],
    "FOUR ticks for what the queue did in ONE — that latency gap IS the fast path",
  );
  assert.ok(
    readWorkSetCursor(fx.workSetCursorPath).offset >= hotRowStart,
    "and only now has the cursor walked past the hot row's offset",
  );
});

// (b) --------------------------------------------------------------------
// THE ENQUEUED-BUT-SINCE-EMBEDDED CASE. e3 names it as a disagreement case; it
// is a COST disagreement, not a correctness one, and the cost lands on
// opposite sides. The queue cannot know the id was embedded after it was
// enqueued — `appendReEmbedSweep` is append-only and has no retraction — so it
// spends a child spawn AND the drain's whole-file `scanSidecarForIds` pass (the
// r6-2 shape: on the live tree that file is 12.4 GB) proving what the id_map
// already knew. The derived path answers the same question from the 3.98 MB
// hnsw meta it already read, and never walks the sidecar at all.
//
// RED BEFORE GREEN (2026-08-19, captured not predicted). The counterfactual is
// `readWorkSetExclusions` in mcp/lib/recall/embed-work-set.js returning
// `{ excludeIds: new Set(), ... }` — the world in which the derived path has no
// cheap already-embedded answer either. The arm then fails VERBATIM:
//
//   not ok 1 - e3 (b): an enqueued-but-since-embedded id costs the QUEUE a
//   full-scan proof and the DERIVED path nothing
//     ---
//     failureType: 'testCodeFailure'
//     error: |-
//       the id is an EXACT BARE id_map entry, so readWorkSetExclusions holds it
//
//       false !== true
//
//     expected: true
//     actual: false
//
// and the derived run then reaches the child and the same full-scan route the
// queue pays. embed-work-set.js was restored byte-identically afterwards
// (sha256 re-checked: 5e33e2a98c6e4e89fb687a96f35c6fa577694dbc99023dbb23cbe77765fabbda).
// ---------------------------------------------------------------------------
test("e3 (b): an enqueued-but-since-embedded id costs the QUEUE a full-scan proof and the DERIVED path nothing", async () => {
  const fx = makeWorkSetFixture({
    rows: [needsEmbedRow("mem_since_embedded")],
    idMap: [["mem_since_embedded", 0]], // ONE complete vector, indexed
    sweepLines: [sweepRow("mem_since_embedded")], // enqueued back when it wasn't
  });
  appendSidecar(fx, ["mem_since_embedded"]); // and the vector is on disk

  // --- QUEUE SIDE ----------------------------------------------------------
  // The real child's `loadDoneIds` (reembed-local-4096.mjs) skips an id whose
  // vector is already in the sidecar, so it exits 0 having written nothing and
  // reports `pending: 0`. classifyWorkProof routes that to
  // CHILD_ALREADY_EMBEDDED, which runDrain refuses to accept on the child's
  // word and upgrades with a WHOLE-FILE scan before it will advance a cursor.
  const already = vacuousRepair({
    child_work_evidence: { completed: true, embedded: 0, facts: 0, pending: 0 },
  });
  const queueRun = await runDrain(proofOpts(fx, { batch: 10, repair: already.fn }));
  assert.deepEqual(
    already.calls,
    [["mem_since_embedded"]],
    "the queue spends a child spawn on an id that needed nothing",
  );
  assert.equal(queueRun.reason, "drained");
  assert.equal(
    queueRun.workEvidence,
    "sidecar-full-scan",
    "and the PARENT then pays a whole-file sidecar scan to prove it — the r6-2 route",
  );
  assert.equal(queueRun.vectorsWritten, 0, "for zero new vectors");

  // --- DERIVED SIDE --------------------------------------------------------
  const exclusions = readWorkSetExclusions({
    hnswMetaPath: fx.hnswMetaPath,
    modelVersion: fx.modelVersion,
  });
  assert.equal(
    exclusions.excludeIds.has("mem_since_embedded"),
    true,
    "the id is an EXACT BARE id_map entry, so readWorkSetExclusions holds it",
  );

  const derivedRepair = recordingRepair(fx);
  const derivedRun = await runDrain(ledgerOpts(fx, { batch: 10, repair: derivedRepair.fn }));
  assert.equal(derivedRun.reason, "nothing-to-derive", "a MEASURED empty window, not an absence");
  assert.deepEqual(derivedRepair.calls, [], "no child spawn...");
  const rec = readLogRecords(fx.logPath)
    .filter((r) => r.event === "reembed-drain" && r.work_set_mode === "ledger")
    .pop();
  assert.equal(rec.candidates, 1, "the row DID match the predicate...");
  assert.equal(rec.excluded, 1, "...and was dropped by the exclusion set, before any spawn");
  assert.equal(rec.reached_eof, true);
  assert.equal(
    existsSync(fx.workSetCursorPath),
    false,
    "and no cursor moved: a proof-free advance is never invented here either",
  );
});

// (c) --------------------------------------------------------------------
// CONTENT-BLINDNESS — the asymmetry that runs the OTHER way, and the one the
// e3 spec does not mention. `appendReEmbedSweep`'s SOLE call site
// (daemons/watermark.js, `if (hadContent) appendReEmbedSweep(...)`) means every
// id in the queue had resolvable content at enqueue time. The derived predicate
// is `readRowEmbedInputs(row).embedState === TRUE` and reads NEITHER `kind` NOR
// `content` — so it can hand the child ids the child's own `collectContents`
// will drop (`r.kind !== "fact"`, or `c.length === 0`), which the queue by
// construction cannot. This is a KEEP argument the spec did not make.
//
// RED BEFORE GREEN (2026-08-19, captured not predicted). The counterfactual is
// giving `deriveWorkSetBatch`'s walk the queue's own resolvability guard —
// `if (row.kind !== "fact") return;` immediately after the predicate. The arm
// then fails at its first assertion, VERBATIM:
//
//   not ok 1 - e3 (c): the derived predicate is CONTENT-BLIND, so it derives
//   candidates the queue could not hold
//     ---
//     failureType: 'testCodeFailure'
//     error: |-
//       embed_state is the WHOLE predicate: no kind filter, no content check,
//       by construction
//       + actual - expected
//
//         [
//           'mem_resolvable_00001',
//           'mem_no_content_0002',
//       -   'mem_not_a_fact_0003'
//         ]
//
//     operator: 'deepStrictEqual'
//
// embed-work-set.js was restored byte-identically afterwards (sha256
// re-checked: 5e33e2a98c6e4e89fb687a96f35c6fa577694dbc99023dbb23cbe77765fabbda).
// ---------------------------------------------------------------------------
test("e3 (c): the derived predicate is CONTENT-BLIND, so it derives candidates the queue could not hold", async () => {
  const fx = makeWorkSetFixture({
    rows: [
      censusRow("mem_resolvable_00001", {
        features: { embed_state: true },
        content: "a real fact with real text",
      }),
      needsEmbedRow("mem_no_content_0002"), // a fact row with NO content key
      censusRow("mem_not_a_fact_0003", { kind: "policy", features: { embed_state: true } }),
    ],
    idMap: [],
    sweepLines: [], // the queue holds none of them — `hadContent` saw to that
  });

  const derived = deriveWorkSetBatch({ ledgerPath: fx.ledgerPath, cursor: 0, batch: 10 });
  assert.deepEqual(
    derived.ids,
    ["mem_resolvable_00001", "mem_no_content_0002", "mem_not_a_fact_0003"],
    "embed_state is the WHOLE predicate: no kind filter, no content check, by construction",
  );
  assert.equal(derived.candidateRows, 3);
  assert.equal(derived.excluded, 0);

  // THE QUEUE'S SIDE OF THE SAME FIXTURE: it holds nothing, because two of
  // these three could never have been appended to it.
  const queueRepair = recordingRepair(fx);
  const queueRun = await runDrain(proofOpts(fx, { batch: 10, repair: queueRepair.fn }));
  assert.equal(queueRun.reason, "nothing-to-drain");
  assert.deepEqual(queueRepair.calls, []);

  // THE CONSEQUENCE, DRIVEN. The child resolves one of the three and writes one
  // vector; it reports the other two still pending. The parent's tail count (1)
  // does not reconcile with `pending` (2), so the batch is a MEASURED NEGATIVE:
  // loud, cursor frozen, ids named. The fail direction is the safe one — and
  // note that the ONE resolvable fact is stalled along with them, because the
  // proof is batch-level. That is a real cost of derived over-inclusion, and it
  // is stated rather than smoothed over.
  const partial = {
    calls: [],
    fn: async (ids) => {
      partial.calls.push([...ids]);
      appendSidecar(fx, ["mem_resolvable_00001"]);
      return {
        ok: true,
        exitCode: 0,
        detail: null,
        child_work_evidence: { completed: true, embedded: 1, facts: 1, pending: 2 },
      };
    },
  };
  const derivedRun = await runDrain(ledgerOpts(fx, { batch: 10, repair: partial.fn }));
  assert.equal(derivedRun.reason, "repair-no-work");
  assert.equal(derivedRun.exitCode, 1);
  assert.equal(derivedRun.workEvidence, "sidecar-tail-shortfall");
  assert.equal(derivedRun.unproven, 2);
  const rec = readLogRecords(fx.logPath)
    .filter((r) => r.event === "reembed-drain" && r.reason === "repair-no-work")
    .pop();
  assert.deepEqual(
    [...rec.unproven_sample].sort(),
    ["mem_no_content_0002", "mem_not_a_fact_0003"],
    "the stall NAMES the two rows the child could not resolve",
  );
  assert.equal(
    existsSync(fx.workSetCursorPath),
    false,
    "and freezes rather than skipping them — the safe direction, unchanged",
  );
});

// (d) --------------------------------------------------------------------
// THE COST ARM'S OWN LICENCE. mcp/scripts/verify-embed-work-set.mjs grew an
// e3 `--sweep` arm so ONE tool times both mechanisms. Its `walkSweepQueue`
// re-states the byte-accounting and distinctness rules of `collectBatch` in
// daemons/reembed-drain.mjs, because `collectBatch` is module-private and
// exporting it would be a NON-COMMENT edit to a file wired into a LOADED plist
// with StartInterval 900 and RunAtLoad true. This arm is what makes that
// duplication safe: the two spellings are driven over the SAME fixture — one
// through the shipped CLI, one through a real sweep-mode `runDrain` — and must
// agree on the consumed offset, the distinct id count and the malformed count.
// A queue with a malformed line, a blank line and a RE-ENQUEUED id, so all
// three rules are exercised rather than merely present.
//
// RED BEFORE GREEN (2026-08-19, captured not predicted). The counterfactual is
// `walkSweepQueue`'s advance changed from `offset += lineBytes` to
// `offset += nl` — dropping the "\n" from the consumed count, the single
// easiest way for a second spelling to drift from the first. The arm then
// fails VERBATIM, on the whole-file offset assertion (six lines, six lost
// bytes) before it even reaches the drain comparison:
//
//   not ok 1 - e3 (d): the CLI's --sweep walker and the DRAIN's collectBatch
//   agree on the same queue
//     ---
//     failureType: 'testCodeFailure'
//     error: |-
//       Expected values to be strictly equal:
//
//       231 !== 237
//
//     expected: 237
//     actual: 231
//
// verify-embed-work-set.mjs was restored byte-identically afterwards (sha256
// re-checked: 548795a6f2bed9285b3d5f9efcd29549dc24dde220a17c6fbb2d0367a1e22c42).
// ---------------------------------------------------------------------------
test("e3 (d): the CLI's --sweep walker and the DRAIN's collectBatch agree on the same queue", async () => {
  const fx = makeWorkSetFixture({
    rows: [needsEmbedRow("mem_ledger_side_001")],
    idMap: [],
    sweepLines: [
      sweepRow("mem_q1"),
      sweepRow("mem_q2"),
      "{ this line is not json",
      sweepRow("mem_q1"), // re-enqueued: consumes bytes, does not grow the batch
      sweepRow("mem_q3"),
      "", // a blank line, which is skipped without being called malformed
    ],
  });
  const baseArgs = [
    `--model-version=${fx.modelVersion}`,
    `--ledger=${fx.ledgerPath}`,
    `--hnsw-meta=${fx.hnswMetaPath}`,
    `--cursor=${fx.workSetCursorPath}`,
    "--batch=3",
  ];

  // WITHOUT --sweep the arm is entirely absent: not a key, not a counter.
  const plain = runWorkSetCli(fx, baseArgs);
  assert.equal(plain.status, 0, plain.stderr);
  const plainPayload = JSON.parse(plain.stdout.trim());
  assert.equal("sweep_queue" in plainPayload, false, "the e3 arm is OPT-IN");
  assert.equal("sweep_arm_ms" in plainPayload.cost, false, "and adds no cost key when off");

  // WITH --sweep, run BEFORE the drain so the queue cursor is genuinely absent.
  const withSweep = runWorkSetCli(fx, [
    ...baseArgs,
    `--sweep=${fx.sweepPath}`,
    `--sweep-cursor=${fx.cursorPath}`,
  ]);
  assert.equal(withSweep.status, 0, withSweep.stderr);
  const q = JSON.parse(withSweep.stdout.trim()).sweep_queue;
  assert.equal(q.measured, true);
  assert.equal(q.idle_common_path.cursor_present, false, "no cursor yet — offset 0, honestly");
  assert.equal(q.idle_common_path.rows_scanned, 0, "the idle path scans NOTHING...");
  assert.equal(q.idle_common_path.bytes_scanned, 0, "...which is the whole KEEP cost argument");
  assert.equal(q.idle_common_path.sweep_size, statSync(fx.sweepPath).size);
  assert.equal(q.sweep_file.size, statSync(fx.sweepPath).size, "identity, not name");
  assert.equal(q.sweep_file.ino, statSync(fx.sweepPath).ino);
  assert.equal(q.whole_file_walk.distinct_ids, 3, "three distinct ids in six lines");
  assert.equal(q.whole_file_walk.rows_scanned, 6);
  assert.equal(q.whole_file_walk.skipped_malformed, 1, "the blank line is NOT malformed");
  assert.equal(q.whole_file_walk.next_offset, statSync(fx.sweepPath).size);
  assert.deepEqual(
    readdirSync(join(fx.dir, "policy")).sort(),
    ["re-embed-sweep.jsonl"],
    "and the arm wrote nothing: no cursor, no lock, no tmp",
  );

  // THE EQUIVALENCE. Same queue, same batch, through the LIVE drain.
  const rep = recordingRepair(fx);
  const run = await runDrain(proofOpts(fx, { batch: 3, repair: rep.fn }));
  assert.equal(run.reason, "drained");
  assert.equal(
    q.batch_walk.next_offset,
    run.offsetAfter,
    "the walker consumes EXACTLY the bytes collectBatch consumes — including the malformed " +
      "line's and the duplicate's",
  );
  assert.equal(q.batch_walk.distinct_ids, run.drained, "and counts the same DISTINCT ids");
  assert.equal(
    q.batch_walk.skipped_malformed,
    run.skippedMalformed,
    "and the same malformed lines",
  );
  assert.deepEqual(rep.calls, [["mem_q1", "mem_q2", "mem_q3"]]);
  assert.equal(q.batch_walk.reached_eof, false, "the batch filled before eof");

  // A REQUESTED COMPARISON THAT CANNOT BE MADE IS A REFUSAL, never a permit
  // carrying a silent zero (invariant #1) — and it is the `2 unmeasurable`
  // grade, not the `3 instrument invariant` one.
  const gone = runWorkSetCli(fx, [
    ...baseArgs,
    `--sweep=${join(fx.dir, "policy", "no-such-sweep.jsonl")}`,
  ]);
  assert.equal(gone.status, 2);
  const gonePayload = JSON.parse(gone.stdout.trim());
  assert.equal(gonePayload.verdict, "refuse");
  assert.equal(gonePayload.measured, false);
  assert.equal(gonePayload.error_code, "work_set_sweep_unreadable");
  assert.equal("sweep_queue" in gonePayload, false, "a refusal carries NO measurement");
  assert.equal("batches" in gonePayload, false);
});
