// stage0-telemetry.test.mjs — dedicated unit tests for
// mcp/lib/ingest/stage0/telemetry.js.
//
// Closes the coverage gap flagged by F-NEW-R40-TELEMETRY-UNIT-TESTS:
// the original stage0-modules suite exercised the per-source decision
// tables but did NOT cover the telemetry primitives (recordDrop,
// allowlist drift warning, cardinality cap, JSONL flush, reconciler).
//
// HERMETIC: all I/O is scoped to a per-run temp dir under os.tmpdir(),
// reached by setting MEMORY_ROOT before importing the module. Each test
// resetForTests() so the in-process Map / warning set / increment
// counter never leaks between cases.
//
// Style matches the rest of mcp/test/: plain ESM, assert.strict, one
// console.log per group, `ok()` counter at the bottom. Runnable as
// `node test/ingest/stage0-telemetry.test.mjs` exactly like its
// neighbours — no `node --test` harness needed (the project's package
// `test` script invokes test files directly via `node`).

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Per-run hermetic root. MUST be set before importing the telemetry
// module so STORAGE_DIR resolves into the temp dir.
const HERMETIC_ROOT = mkdtempSync(join(tmpdir(), "stage0-telemetry-test-"));
process.env.MEMORY_ROOT = HERMETIC_ROOT;
// Also explicitly override STORAGE_BASE_DIR so an outer-shell value
// cannot leak past the MEMORY_ROOT-derived default.
process.env.STORAGE_BASE_DIR = join(HERMETIC_ROOT, "storage");

const {
  REASON_ALLOWLIST,
  TELEMETRY_REASON_CAP,
  TELEMETRY_FLUSH_EVERY_N,
  currentSinkPath,
  flushCounters,
  reconcileReasonAllowlist,
  recordDrop,
  resetForTests,
  snapshotCounters,
} = await import("../../lib/ingest/stage0/telemetry.js");

let passed = 0;
function ok(msg) {
  passed++;
  console.log(`  ok ${msg}`);
}

// Cleanup on exit (best-effort; if the process dies hard the per-run
// temp dir leaks, but that's acceptable for a unit test).
process.on("exit", () => {
  try {
    rmSync(HERMETIC_ROOT, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
// 1. recordDrop bumps the counter for an allowlisted reason.
// ---------------------------------------------------------------------------
console.log("# recordDrop — counter increment");
{
  resetForTests();
  // "tapback" is on REASON_ALLOWLIST.
  const canon = recordDrop("imessage", "tapback", "DROP");
  assert.strictEqual(canon, "tapback");
  const snap = snapshotCounters();
  const row = snap.find(
    (r) => r.source === "imessage" && r.reason === "tapback"
  );
  assert.ok(row, "expected an imessage::DROP::tapback row");
  assert.strictEqual(row.count, 1);
  assert.strictEqual(row.decision, "DROP");
  ok("recordDrop(imessage, tapback, DROP) increments the counter to 1");

  // Second increment hits the existing-key fast path.
  recordDrop("imessage", "tapback", "DROP");
  const snap2 = snapshotCounters();
  const row2 = snap2.find(
    (r) => r.source === "imessage" && r.reason === "tapback"
  );
  assert.strictEqual(row2.count, 2);
  ok("second recordDrop bumps the same key to 2");
}

// ---------------------------------------------------------------------------
// 2. Allowlist drift: a novel reason buckets into 'invalid_reason' AND
//    warns once on stderr.
// ---------------------------------------------------------------------------
console.log("# recordDrop — allowlist drift detection");
{
  resetForTests();
  const originalWarn = console.warn;
  const warnings = [];
  // eslint-disable-next-line no-global-assign
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const canon1 = recordDrop("fake-source", "totally_novel_reason", "DROP");
    assert.strictEqual(canon1, "invalid_reason");
    // Second call with the SAME novel reason must NOT warn again
    // (one-shot dedupe gate).
    const canon2 = recordDrop("fake-source", "totally_novel_reason", "DROP");
    assert.strictEqual(canon2, "invalid_reason");
  } finally {
    // eslint-disable-next-line no-global-assign
    console.warn = originalWarn;
  }
  assert.strictEqual(
    warnings.length,
    1,
    `expected exactly one warning, got ${warnings.length}: ${JSON.stringify(warnings)}`
  );
  assert.ok(
    warnings[0].includes("totally_novel_reason"),
    "warning mentions the novel reason"
  );
  assert.ok(
    warnings[0].includes("REASON_ALLOWLIST"),
    "warning points the operator at REASON_ALLOWLIST"
  );

  const snap = snapshotCounters();
  const row = snap.find(
    (r) => r.source === "fake-source" && r.reason === "invalid_reason"
  );
  assert.ok(row, "novel reason bucketed into invalid_reason");
  assert.strictEqual(row.count, 2, "both novel-reason calls counted");
  ok(
    "novel reason buckets into 'invalid_reason' and emits exactly one stderr warning"
  );
}

// ---------------------------------------------------------------------------
// 3. Cardinality cap: once the Map hits TELEMETRY_REASON_CAP distinct
//    keys, NEW keys fold into the per-(source,decision) 'other' bucket.
//
// IMPLEMENTATION NOTE: the production auto-flush at
// TELEMETRY_FLUSH_EVERY_N=1000 would normally wipe the Map long
// before we reach the 10_000 cap. To exercise the cap path without
// modifying telemetry.js, we sabotage the tick-flush: we replace the
// expected sink JSONL FILE PATH with a directory of the same name.
// `appendFileSync` then throws EISDIR. That exception propagates out
// of `flushCounters` BEFORE the Map.clear() at the end of the happy
// path, so the in-memory Map keeps growing. recordDrop's own
// try/catch swallows the exception so the hot path stays alive.
//
// With writes blocked, we can deterministically drive 10_001 distinct
// keys into the Map and assert that key 10_001 folds into the
// per-(source,decision) 'other' bucket rather than growing the Map.
// ---------------------------------------------------------------------------
console.log("# recordDrop — cardinality cap");
{
  resetForTests();
  // Sabotage the tick-flush by claiming the sink-file path as a dir.
  // The telemetry parent dir already exists (or is created); we
  // pre-make the JSONL filename as a directory so appendFileSync
  // throws EISDIR.
  mkdirSync(currentSinkPath(), { recursive: true });

  for (let i = 0; i < TELEMETRY_REASON_CAP; i++) {
    recordDrop(`src${i}`, "tapback", "DROP");
  }
  assert.strictEqual(
    snapshotCounters().length,
    TELEMETRY_REASON_CAP,
    `expected exactly ${TELEMETRY_REASON_CAP} distinct keys before overflow`
  );
  ok(`drove Map to TELEMETRY_REASON_CAP (${TELEMETRY_REASON_CAP}) distinct keys`);

  // Event #10_001 (and #10_002) — a new (source, decision) tuple
  // must fold into `overflow-A::DROP::other`, NOT add a new key.
  recordDrop("overflow-A", "tapback", "DROP");
  recordDrop("overflow-A", "tapback", "DROP");
  const snap = snapshotCounters();
  assert.strictEqual(
    snap.length,
    TELEMETRY_REASON_CAP + 1,
    "overflow added exactly one new key (the per-source 'other' bucket)"
  );
  const overflowRow = snap.find(
    (r) =>
      r.source === "overflow-A" &&
      r.decision === "DROP" &&
      r.reason === "other"
  );
  assert.ok(overflowRow, "expected an overflow row at overflow-A::DROP::other");
  assert.strictEqual(overflowRow.count, 2, "two overflow calls counted");
  ok(
    `event #${TELEMETRY_REASON_CAP + 1} and #${TELEMETRY_REASON_CAP + 2} fold into per-source 'other' bucket`
  );

  // A SECOND distinct overflow source also folds into ITS own 'other'
  // bucket (one overflow row per source, not a global overflow row).
  recordDrop("overflow-B", "tapback", "DROP");
  const snap2 = snapshotCounters();
  assert.strictEqual(snap2.length, TELEMETRY_REASON_CAP + 2);
  const overflowB = snap2.find(
    (r) => r.source === "overflow-B" && r.reason === "other"
  );
  assert.ok(overflowB, "second overflow source got its OWN 'other' bucket");
  ok("overflow buckets are keyed per-(source, decision), not global");

  // Synthetic 'other' bucket is in the allowlist so cap-overflow rows
  // can be flushed downstream.
  assert.ok(REASON_ALLOWLIST.has("other"), "'other' bucket allowlisted");
  // The hardcoded constant matches the design doc.
  assert.strictEqual(TELEMETRY_REASON_CAP, 10_000);
  ok("TELEMETRY_REASON_CAP = 10_000 and 'other' bucket is allowlisted");

  // Tear down: remove the directory we created in place of the JSONL
  // file so subsequent flushCounters tests have a clean sink path.
  try {
    rmSync(currentSinkPath(), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  // Also clear the Map so we don't carry a 10k-key Map into the next
  // group. resetForTests() does exactly that.
  resetForTests();
}

// ---------------------------------------------------------------------------
// 4. flushCounters writes a valid JSONL row to the dated sink and
//    clears the Map.
// ---------------------------------------------------------------------------
console.log("# flushCounters — JSONL sink + Map reset");
{
  resetForTests();
  recordDrop("imessage", "tapback", "DROP");
  recordDrop("imessage", "tapback", "DROP");
  recordDrop("mail", "list_id", "DROP");

  const path = currentSinkPath();
  // The dir is auto-created by flushCounters, but the file may already
  // exist from a previous test run inside the same temp dir (it won't
  // because we mkdtempSync per run, but be defensive).
  const result = flushCounters({ flush_kind: "manual", sync: true });
  assert.strictEqual(result.wrote, true);
  assert.strictEqual(result.rows, 2, "two distinct keys → two counter rows");
  assert.strictEqual(result.path, path);

  // Map must be empty post-flush.
  assert.strictEqual(snapshotCounters().length, 0);

  // The JSONL file must contain a single line, JSON-parseable, with the
  // expected shape.
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  assert.strictEqual(lines.length, 1, "one JSONL row per flush");
  const row = JSON.parse(lines[0]); // throws if invalid JSON
  assert.strictEqual(typeof row.ts, "string");
  assert.strictEqual(row.flush_kind, "manual");
  assert.strictEqual(row.total_counted, 3, "2 + 1 = 3 events counted");
  assert.strictEqual(row.distinct_keys, 2);
  assert.ok(Array.isArray(row.counters));
  assert.strictEqual(row.counters.length, 2);

  // counters sorted deterministically (source, decision, reason)
  // → imessage before mail.
  assert.strictEqual(row.counters[0].source, "imessage");
  assert.strictEqual(row.counters[0].reason, "tapback");
  assert.strictEqual(row.counters[0].count, 2);
  assert.strictEqual(row.counters[1].source, "mail");
  assert.strictEqual(row.counters[1].reason, "list_id");
  assert.strictEqual(row.counters[1].count, 1);
  ok("flushCounters writes a single valid JSONL row to the dated sink");

  // A second flush with empty Map writes nothing and returns wrote=false.
  const empty = flushCounters({ flush_kind: "manual", sync: true });
  assert.strictEqual(empty.wrote, false);
  assert.strictEqual(empty.rows, 0);
  ok("flushCounters on empty Map returns {wrote:false, rows:0}");

  // The sink path must encode the UTC date.
  const expectedDate = currentSinkPath(new Date("2027-01-15T12:00:00Z"));
  assert.ok(expectedDate.endsWith("stage0_counters_2027-01-15.jsonl"));
  ok("currentSinkPath() encodes the UTC date in the filename");
}

// ---------------------------------------------------------------------------
// 5. reconcileReasonAllowlist detects a fake stage0 module's novel
//    reason via static scan of its source file.
// ---------------------------------------------------------------------------
console.log("# reconcileReasonAllowlist — drift detection");
{
  // Production reconcile (no override) must currently report clean,
  // because the real per-source modules are all in sync with the
  // allowlist as of this commit. If a future change breaks that, this
  // assertion is exactly the signal we want.
  const realReport = reconcileReasonAllowlist();
  assert.ok(
    Array.isArray(realReport.scanned_files) && realReport.scanned_files.length > 0,
    "scanned some per-source files"
  );
  assert.deepStrictEqual(
    realReport.missing_from_allowlist,
    [],
    `production allowlist drift detected: ${realReport.missing_from_allowlist.join(", ")}`
  );
  ok(
    `reconcileReasonAllowlist() reports zero drift across ${realReport.scanned_files.length} real per-source modules`
  );

  // Synthesize a fake stage0 dir with one module that emits a novel
  // reason. The reconciler should surface it in missing_from_allowlist.
  const fakeDir = join(HERMETIC_ROOT, "fake-stage0");
  mkdirSync(fakeDir, { recursive: true });
  writeFileSync(
    join(fakeDir, "fakesrc.js"),
    `// synthetic stage0 module for the reconciler test
export function stage0(ev) {
  if (ev.x) return { decision: "DROP", reason: "this_reason_is_unknown" };
  return { decision: "PASS", reason: null };
}
`,
    "utf8"
  );
  // Mirror the production-dir layout: include a telemetry.js and
  // index.js that the reconciler must skip. We give them a stub reason
  // literal that, if accidentally scanned, would be picked up and
  // assertion would fail.
  writeFileSync(
    join(fakeDir, "telemetry.js"),
    `// reconciler MUST skip this file
const _ = { reason: "ghost_reason_telemetry_file" };
`,
    "utf8"
  );
  writeFileSync(
    join(fakeDir, "index.js"),
    `// reconciler MUST skip this file
const _ = { reason: "ghost_reason_index_file" };
`,
    "utf8"
  );

  const report = reconcileReasonAllowlist(fakeDir);
  assert.deepStrictEqual(
    report.missing_from_allowlist,
    ["this_reason_is_unknown"],
    "novel reason surfaced exactly once"
  );
  // The two ghost reasons must NOT appear — the reconciler skips
  // telemetry.js and index.js.
  assert.ok(
    !report.reasons_in_code.has("ghost_reason_telemetry_file"),
    "telemetry.js skipped"
  );
  assert.ok(
    !report.reasons_in_code.has("ghost_reason_index_file"),
    "index.js skipped"
  );
  // unused_allowlist_entries reflects allowlist entries the fake dir
  // does not emit — that's almost all of them, but it must NOT include
  // the synthetic buckets (pass, other, invalid_reason, unknown_source).
  for (const synthetic of ["pass", "other", "invalid_reason", "unknown_source"]) {
    assert.ok(
      !report.unused_allowlist_entries.includes(synthetic),
      `${synthetic} (synthetic bucket) must not be flagged unused`
    );
  }
  ok(
    "reconcileReasonAllowlist(fakeDir) flags the novel reason and skips telemetry.js/index.js"
  );
}

// ---------------------------------------------------------------------------
// 6. Misc invariants on REASON_ALLOWLIST itself.
// ---------------------------------------------------------------------------
console.log("# REASON_ALLOWLIST — invariants");
{
  // Frozen so userland cannot mutate the set at runtime.
  assert.ok(Object.isFrozen(REASON_ALLOWLIST));
  // Synthetic buckets are present.
  for (const synthetic of ["pass", "other", "invalid_reason", "unknown_source"]) {
    assert.ok(
      REASON_ALLOWLIST.has(synthetic),
      `synthetic bucket ${synthetic} must be in allowlist`
    );
  }
  // Caps are positive integers.
  assert.ok(Number.isInteger(TELEMETRY_REASON_CAP) && TELEMETRY_REASON_CAP > 0);
  assert.ok(
    Number.isInteger(TELEMETRY_FLUSH_EVERY_N) && TELEMETRY_FLUSH_EVERY_N > 0
  );
  ok("REASON_ALLOWLIST is frozen, includes synthetic buckets, caps are positive");
}

// ---------------------------------------------------------------------------
// 7. F-NEW-W1-R40-CONST-BOUND-REASONS — the reconciler's second pass
//    resolves `const REASON_X = "literal"` declarations into the
//    reasons_in_code set, so const-bound reasons that route through an
//    intermediate binding (ternary, switch, helper arg) are no longer
//    surfaced as false-positive unused_allowlist_entries.
//
// Synthesizes a fake stage0 module that mirrors the patterns
// githubevents.js uses for branch_lifecycle / orphan / dup-of-gitlog and
// asserts:
//   - direct `reason: REASON_X` usages resolve;
//   - ternary-routed `dropReason = c ? REASON_X : REASON_Y` then
//     `reason: dropReason` resolves;
//   - a declared-but-unreferenced const does NOT resolve (decl-only
//     identifiers must remain in unused_allowlist_entries so the
//     operator notices truly dead reasons).
// ---------------------------------------------------------------------------
console.log("# reconcileReasonAllowlist — const-bound reason resolution");
{
  const fakeDir = join(HERMETIC_ROOT, "fake-stage0-const");
  mkdirSync(fakeDir, { recursive: true });
  writeFileSync(
    join(fakeDir, "fakesrc.js"),
    `// synthetic stage0 module exercising const-bound reasons.
const REASON_DIRECT = "direct_const_reason_xx";
const REASON_TERNARY_A = "ternary_const_reason_aa";
const REASON_TERNARY_B = "ternary_const_reason_bb";
const REASON_DECL_ONLY = "decl_only_reason_zz";
export function stage0(ev) {
  if (ev.kind === "direct") {
    return { decision: "DROP", reason: REASON_DIRECT };
  }
  if (ev.kind === "ternary") {
    const dropReason = ev.flag ? REASON_TERNARY_A : REASON_TERNARY_B;
    return { decision: "DROP", reason: dropReason };
  }
  return { decision: "PASS", reason: null };
}
`,
    "utf8"
  );
  const report = reconcileReasonAllowlist(fakeDir);
  // Direct + both ternary branches should appear in reasons_in_code.
  assert.ok(
    report.reasons_in_code.has("direct_const_reason_xx"),
    "direct const-bound reason resolved"
  );
  assert.ok(
    report.reasons_in_code.has("ternary_const_reason_aa"),
    "ternary-A const-bound reason resolved"
  );
  assert.ok(
    report.reasons_in_code.has("ternary_const_reason_bb"),
    "ternary-B const-bound reason resolved"
  );
  // The decl-only const has NO non-declaration references, so the
  // reconciler must NOT promote it into reasons_in_code (the decl
  // sighting alone is not evidence of dispatch flow).
  assert.ok(
    !report.reasons_in_code.has("decl_only_reason_zz"),
    "decl-only const-bound reason is NOT resolved (no usage)"
  );
  ok(
    "const-bound reasons (direct + ternary) resolve; decl-only const stays unresolved"
  );

  // Sanity-check against the real production stage0 dir: the three
  // const-bound reasons that motivated this enhancement
  // (branch_lifecycle / gh_branch_lifecycle_orphan_drop /
  // duplicate_of_gitlog_commit, all routed via ternary or direct const
  // in githubevents.js) must now be in reasons_in_code and therefore
  // NOT in unused_allowlist_entries.
  const realReport = reconcileReasonAllowlist();
  for (const r of [
    "branch_lifecycle",
    "gh_branch_lifecycle_orphan_drop",
    "duplicate_of_gitlog_commit",
  ]) {
    assert.ok(
      realReport.reasons_in_code.has(r),
      `production reason "${r}" must be resolved via const-bound pass`
    );
    assert.ok(
      !realReport.unused_allowlist_entries.includes(r),
      `production reason "${r}" must not be flagged unused`
    );
  }
  ok(
    "production const-bound reasons (branch_lifecycle / orphan / gitlog-dup) no longer flagged unused"
  );
}

// ---------------------------------------------------------------------------
// 8. F-NEW-W1-R40-TELEMETRY-LIFECYCLE-TESTS — shutdown flush + day
//    rollover. The two operational paths most likely to leak in
//    production:
//      (a) SIGTERM mid-flight: the counter Map must be flushed to the
//          dated JSONL sink before the process exits. We spawn a child
//          node process so SIGTERM does not kill the test runner.
//      (b) UTC midnight crossing: a flush after midnight must land in
//          the NEW dated filename, not the previous day's file. We use
//          currentSinkPath(date) as the dated-filename oracle — it
//          already accepts an injectable date so the test does not have
//          to monkey-patch Date.now().
// ---------------------------------------------------------------------------
console.log("# telemetry lifecycle — shutdown flush + day rollover");
{
  // --- (a) shutdown flush via SIGTERM in a child process ---
  // Use the project module path via file: URL so the child sees the
  // exact same telemetry.js source as this test. Pass MEMORY_ROOT +
  // STORAGE_BASE_DIR so the child writes into the hermetic temp dir.
  const { spawnSync } = await import("node:child_process");
  const childRoot = mkdtempSync(join(tmpdir(), "stage0-telemetry-shutdown-"));
  const childScript = `
    import { recordDrop } from "${join(process.cwd(), "lib/ingest/stage0/telemetry.js")}";
    // Drop a single allowlisted reason so the Map has something to flush.
    recordDrop("imessage", "tapback", "DROP");
    // Tell the parent we are ready, then wait for SIGTERM. The
    // beforeExit / SIGTERM hook in telemetry.js MUST flush before the
    // process actually exits.
    process.stdout.write("READY\\n");
    setTimeout(() => process.exit(0), 30_000);
  `;
  // Write the child script under the hermetic root so the child's
  // import resolution sees the project's package.json (ESM via .mjs
  // extension to skip the type:module check).
  const childScriptPath = join(childRoot, "child.mjs");
  writeFileSync(childScriptPath, childScript, "utf8");

  // Spawn the child with its own MEMORY_ROOT so the dated sink lands
  // in childRoot/storage/telemetry/...
  const childEnv = {
    ...process.env,
    MEMORY_ROOT: childRoot,
    STORAGE_BASE_DIR: join(childRoot, "storage"),
  };
  // Use `node` to run the child script; spawnSync with `input: ""` makes
  // the child inherit nothing on stdin. We pass --input-type=module via
  // the .mjs extension. The SIGTERM is sent via the `killSignal` after
  // we observe READY on stdout. Simpler than streaming: we use a
  // detached child + spawn (async).
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [childScriptPath], {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    let ready = false;
    const onData = (chunk) => {
      if (String(chunk).includes("READY")) {
        ready = true;
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    setTimeout(() => {
      if (!ready) reject(new Error("child never emitted READY"));
    }, 10_000);
  });
  // Send SIGTERM and wait for exit.
  const exitCode = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.kill("SIGTERM");
  });
  // The child either exits cleanly (re-raised SIGTERM = signal:'SIGTERM')
  // or with code 0 if it raced past. Either is acceptable — what we
  // assert is that the JSONL sink received the flush.
  void exitCode;

  // Locate the child's dated JSONL sink and assert it contains the
  // tapback row. The child wrote to STORAGE_BASE_DIR/telemetry/...
  const childTelemetryDir = join(childRoot, "storage", "telemetry");
  let files = [];
  try {
    files = readdirSync(childTelemetryDir).filter((f) =>
      f.startsWith("stage0_counters_")
    );
  } catch {
    /* sink dir absent → flush did NOT happen, assertion below will fail */
  }
  assert.ok(
    files.length >= 1,
    "shutdown flush wrote at least one dated JSONL file"
  );
  // Read all dated files and look for our tapback row across them.
  let foundTapback = false;
  let foundShutdownKind = false;
  for (const f of files) {
    const raw = readFileSync(join(childTelemetryDir, f), "utf8");
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row.flush_kind === "shutdown") foundShutdownKind = true;
      for (const c of row.counters || []) {
        if (
          c.source === "imessage" &&
          c.reason === "tapback" &&
          c.decision === "DROP" &&
          c.count >= 1
        ) {
          foundTapback = true;
        }
      }
    }
  }
  assert.ok(
    foundTapback,
    "shutdown JSONL contains imessage::DROP::tapback row"
  );
  assert.ok(
    foundShutdownKind,
    "shutdown JSONL row carries flush_kind='shutdown'"
  );
  ok(
    "SIGTERM child flushed in-memory counters to dated JSONL sink (flush_kind=shutdown)"
  );

  // Cleanup child temp.
  try {
    rmSync(childRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  // --- (b) day-rollover filename selection ---
  // The dated sink filename is computed per-flush via currentSinkPath(date).
  // Verify that crossing UTC midnight selects the NEW day's filename
  // (and that filenames for the two boundary instants differ).
  const justBeforeMidnight = new Date("2027-03-15T23:59:59.999Z");
  const justAfterMidnight = new Date("2027-03-16T00:00:00.000Z");
  const pathBefore = currentSinkPath(justBeforeMidnight);
  const pathAfter = currentSinkPath(justAfterMidnight);
  assert.ok(
    pathBefore.endsWith("stage0_counters_2027-03-15.jsonl"),
    `pre-midnight path = ${pathBefore}`
  );
  assert.ok(
    pathAfter.endsWith("stage0_counters_2027-03-16.jsonl"),
    `post-midnight path = ${pathAfter}`
  );
  assert.notStrictEqual(
    pathBefore,
    pathAfter,
    "day-rollover yields a DIFFERENT dated filename"
  );
  // Drive an actual flush at each boundary and confirm each writes to
  // the expected dated file. flushCounters re-derives the filename per
  // call via currentSinkPath(new Date()), so we cannot directly inject
  // a fake clock without monkey-patching globals — but the path-oracle
  // assertion above plus the production code path (`const path =
  // currentSinkPath();` in flushCounters) gives us the guarantee that a
  // post-midnight flush WOULD route to pathAfter. Document the seam.
  resetForTests();
  recordDrop("imessage", "tapback", "DROP");
  // Force one flush at "today" so we can confirm the sink-path
  // selection runs through currentSinkPath(new Date()).
  const result = flushCounters({ flush_kind: "rollover_check", sync: true });
  assert.strictEqual(result.wrote, true);
  assert.strictEqual(
    result.path,
    currentSinkPath(new Date()),
    "flushCounters re-derives the sink path from the current Date on every flush — day rollover is implicit"
  );
  ok(
    "day-rollover: currentSinkPath() selects a NEW dated filename across UTC midnight; flushCounters re-derives the path per flush"
  );
}

// Drain any temp-dir telemetry files we created so the next test
// process (if any) sees a clean slate.
{
  const telemetryDir = join(HERMETIC_ROOT, "storage", "telemetry");
  try {
    for (const f of readdirSync(telemetryDir)) {
      assert.ok(f.startsWith("stage0_counters_"), `unexpected file: ${f}`);
    }
  } catch {
    /* no telemetry dir created in some tests; fine */
  }
}

console.log(`\nPASS ${passed} assertions`);
