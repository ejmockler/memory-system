// L3 telemetry gate. Exercises the REAL dispatch seam (executeTool), not a
// mock: per-call line emission, annotate allowlist (leak-fixture included),
// size rotation (keep-2), write-failure drop-safety, forbidden-field lint,
// and the <5ms/call overhead gate.
//
// Run: node test/telemetry.test.mjs
//
// HERMETICITY (standing C-NEW-2 pattern, copied from
// envelope-dispatch.test.mjs): redirect every base dir to a tmpdir BEFORE the
// dynamic imports so config.js binds inside the tmpdir. Static imports are
// hoisted; we MUST use dynamic `await import(...)` for the env-override
// discipline. Never touches the real memory.jsonl or any real ledger.

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  promises as fsp, // SAME object telemetry.js holds — patching it reaches the module
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const TEST_ROOT = mkdtempSync(join(tmpdir(), "telemetry-"));
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
process.env.TELEMETRY_BASE_DIR = join(TEST_ROOT, "telemetry");
// Tiny cap so the rotation case can cross it twice in-process.
const CAP = 4096;
process.env.TELEMETRY_MAX_BYTES = String(CAP);
// Tiny pending-byte budget so case i's gated-writer storm overflows. Kept
// BELOW the rotation cap so the drained backlog spans at most ONE rotation —
// the line that surfaces dropped_since_last stays recoverable from ACTIVE+.1.
process.env.TELEMETRY_MAX_PENDING_BYTES = "2048";
// dispatch.js reads MEMORY_ROLE once at module init; case j needs role=agent.
delete process.env.MEMORY_ROLE;
process.on("exit", () => { try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {} });

const { executeTool } = await import("../lib/dispatch.js");
const {
  withTelemetry,
  annotate,
  _flushTelemetry,
  _telemetryStats,
} = await import("../lib/telemetry.js");
const { telemetryPath } = await import("../lib/config.js");

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const ACTIVE = telemetryPath();
const ROTATED = ACTIVE + ".1";
const TELE_DIR = process.env.TELEMETRY_BASE_DIR;

// Accumulators for the forbidden-field lint (case e): rotation clobbers .1,
// so capture raw content + parsed lines every time we read the files.
let allRaw = "";
const allLines = [];
function harvest() {
  for (const p of [ACTIVE, ROTATED]) {
    if (!existsSync(p)) continue;
    const raw = readFileSync(p, "utf8");
    allRaw += raw;
    for (const l of raw.split("\n")) {
      if (l.trim()) allLines.push(JSON.parse(l));
    }
  }
}

// --- a. one line per call through the real seam -----------------------------
// memory_get is ledger-backed (tools/get.js seeks the offset index); the
// hermetic root above has no ledger, so any id misses with NOT_FOUND. An
// unknown tool name exercises the NOT_FOUND dispatch path.
const envGet = await executeTool("memory_get", { id: "missing_nonexistent" });
const envUnknown = await executeTool("definitely_not_a_tool", {});
await _flushTelemetry();
const rawA = readFileSync(ACTIVE, "utf8");
const linesA = rawA.trim().split("\n").map((l) => JSON.parse(l));
check("a: exactly 2 lines for 2 calls", linesA.length === 2, `got ${linesA.length}`);
check(
  "a: tool names recorded",
  linesA[0]?.tool === "memory_get" && linesA[1]?.tool === "definitely_not_a_tool",
  `got ${linesA.map((l) => l.tool).join(",")}`,
);
check("a: envelopes report the miss/unknown", envGet.ok === false && envUnknown.ok === false);
check("a: ok=false on both lines", linesA.every((l) => l.ok === false));
check(
  "a: total_ms integer >= 0",
  linesA.every((l) => Number.isInteger(l.total_ms) && l.total_ms >= 0),
);
check("a: rss_delta_kb integer", linesA.every((l) => Number.isInteger(l.rss_delta_kb)));
check("a: pid stamped", linesA.every((l) => l.pid === process.pid));
check("a: ts is ISO-8601", linesA.every((l) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(l.ts)));
check(
  "a: distinct non-empty corr_ids",
  typeof linesA[0]?.corr_id === "string" &&
    linesA[0].corr_id.length >= 32 &&
    linesA[0].corr_id !== linesA[1]?.corr_id,
);
check(
  "a: cold_start true on first line only",
  linesA[0]?.cold_start === true && linesA[1]?.cold_start === undefined,
);

// --- b. annotate allowlist ---------------------------------------------------
await withTelemetry("t_annotate", async () => {
  annotate({
    bytes_scanned: 12345,
    degraded_reason: "rerank_key_mismatch",
    stage_ms: { scan: 3.25, "Bad Key!": 9 },
  });
  return { ok: true };
});
// Leak fixture: a non-allowlisted `query` key carrying a marker that the
// forbidden-field regex (case e) WOULD catch if it ever reached disk.
await withTelemetry("t_reject", async () => {
  annotate({ query: "SECRET_MARKER xoxb-fake-token Bearer abc", bytes_scanned: 1 });
  return { ok: true };
});
let annotateOutsideThrew = false;
try {
  annotate({ bytes_scanned: 7, query: "SECRET_MARKER" });
} catch {
  annotateOutsideThrew = true;
}
await _flushTelemetry();
const rawB = readFileSync(ACTIVE, "utf8");
const linesB = rawB.trim().split("\n").map((l) => JSON.parse(l));
const lAnnotate = linesB.find((l) => l.tool === "t_annotate");
const lReject = linesB.find((l) => l.tool === "t_reject");
check("b: bytes_scanned lands", lAnnotate?.bytes_scanned === 12345);
check("b: degraded_reason slug lands", lAnnotate?.degraded_reason === "rerank_key_mismatch");
check(
  "b: stage_ms keeps only valid slug keys",
  lAnnotate?.stage_ms?.scan === 3.25 &&
    Object.keys(lAnnotate?.stage_ms || {}).every((k) => /^[a-z0-9_]{1,32}$/.test(k)),
  `stage_ms=${JSON.stringify(lAnnotate?.stage_ms)}`,
);
check("b: rejected query never reaches disk", !rawB.includes("SECRET_MARKER"));
check("b: allowlisted field beside rejected one still lands", lReject?.bytes_scanned === 1);
check("b: cold_start not repeated after first line", lAnnotate?.cold_start === undefined);
check("b: annotate outside any context does not throw", annotateOutsideThrew === false);
harvest();

// --- c. rotation -------------------------------------------------------------
// Each line is ~140-190 bytes; 120 lines ≈ 20KB crosses the 4096B cap several
// times. Keep-2 must hold: exactly one .1 sibling, never a .2.
for (let i = 0; i < 120; i++) {
  await withTelemetry("t_rotate", async () => ({ ok: true }));
  if (i % 20 === 0) await _flushTelemetry(); // harvest across clobbers
  if (i % 20 === 0) harvest();
}
await _flushTelemetry();
harvest();
check("c: .1 sibling exists after crossing cap", existsSync(ROTATED));
const activeSize = statSync(ACTIVE).size;
const maxLineBytes = Math.max(
  ...readFileSync(ACTIVE, "utf8").trim().split("\n").map((l) => l.length + 1),
);
check(
  "c: active file < cap + one line",
  activeSize < CAP + maxLineBytes,
  `active=${activeSize} cap=${CAP} maxLine=${maxLineBytes}`,
);
check("c: no .2 file ever created (keep-2)", !existsSync(ACTIVE + ".2"));
check("c: rotated file is non-empty NDJSON", statSync(ROTATED).size > 0);

// --- d. write failure cannot fail the call -----------------------------------
harvest();
rmSync(TELE_DIR, { recursive: true, force: true });
writeFileSync(TELE_DIR, "block: a regular file where the dir should be");
const droppedBefore = _telemetryStats().dropped;
const envBroken = await executeTool("definitely_not_a_tool", {});
await _flushTelemetry();
check(
  "d: tool call still returns a well-formed error envelope",
  envBroken.ok === false &&
    envBroken.error?.code === "NOT_FOUND" &&
    envBroken.data === null &&
    envBroken.meta?.tool === "definitely_not_a_tool",
);
check(
  "d: dropped counter increased",
  _telemetryStats().dropped > droppedBefore,
  `before=${droppedBefore} after=${_telemetryStats().dropped}`,
);
// Restore the directory path; the writer must self-heal (re-mkdir) and the
// next successful line must surface the loss.
rmSync(TELE_DIR, { force: true });
await withTelemetry("t_after_restore", async () => ({ ok: true }));
await _flushTelemetry();
const rawD = readFileSync(ACTIVE, "utf8");
const lRestore = rawD
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l))
  .find((l) => l.tool === "t_after_restore");
check(
  "d: next successful line carries dropped_since_last >= 1",
  Number.isInteger(lRestore?.dropped_since_last) && lRestore.dropped_since_last >= 1,
  `line=${JSON.stringify(lRestore)}`,
);
harvest();

// --- f. overhead gate (<5ms/call, 200 wrapped vs 200 bare) --------------------
const bareFn = async () => ({ ok: true });
for (let i = 0; i < 20; i++) {
  await bareFn();
  await withTelemetry("t_perf", bareFn); // warm-up: JIT + dir/size caches
}
await _flushTelemetry();
const tBare0 = performance.now();
for (let i = 0; i < 200; i++) await bareFn();
const tBare = performance.now() - tBare0;
const tWrapped0 = performance.now();
for (let i = 0; i < 200; i++) await withTelemetry("t_perf", bareFn);
const tWrapped = performance.now() - tWrapped0;
const perCall = (tWrapped - tBare) / 200;
check(
  "f: wrapper overhead < 5ms/call",
  perCall < 5,
  `overhead=${perCall.toFixed(4)}ms/call (wrapped=${tWrapped.toFixed(1)}ms bare=${tBare.toFixed(1)}ms)`,
);
await _flushTelemetry();
harvest();

// --- g. rotation errno: loud once per streak, self-healing --------------------
// L3b defect 1 (RED-FIRST): a non-ENOENT rename failure must not be silently
// swallowed with the size cache zeroed. Patch fsp.rename (the SAME promises
// object telemetry.js imported) to throw EACCES, cross the cap repeatedly,
// then require: appends continue, EXACTLY ONE stderr escalation for the whole
// failure streak, rotate_failures exposed in _telemetryStats(), and rotation
// succeeding on the FIRST flush after the fault clears.
await _flushTelemetry();
rmSync(ROTATED, { force: true });
const stderrMarks = [];
const origStderrWrite = process.stderr.write;
process.stderr.write = function (chunk, ...rest) {
  try {
    if (String(chunk).includes("[telemetry] rotation failed")) {
      stderrMarks.push(String(chunk));
    }
  } catch {}
  return origStderrWrite.call(this, chunk, ...rest);
};
const origRename = fsp.rename;
fsp.rename = async () => {
  const e = new Error("EACCES");
  e.code = "EACCES";
  throw e;
};
for (let i = 0; i < 60; i++) {
  await withTelemetry("t_rotfail", async () => ({ ok: true }));
  if (i % 10 === 9) await _flushTelemetry(); // bound queue depth under the byte cap
}
await _flushTelemetry();
const rotfailCount = readFileSync(ACTIVE, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l))
  .filter((l) => l.tool === "t_rotfail").length;
check(
  "g: appends continue during rotation fault (all lines land in ACTIVE)",
  rotfailCount === 60,
  `got ${rotfailCount}`,
);
check(
  "g: exactly one stderr escalation per failure streak",
  stderrMarks.length === 1,
  `got ${stderrMarks.length}`,
);
check(
  "g: escalation carries the errno slug only",
  stderrMarks.length === 1 &&
    stderrMarks[0] === "[telemetry] rotation failed code=EACCES retrying-each-flush\n",
  `got ${JSON.stringify(stderrMarks)}`,
);
check(
  "g: rotate_failures exposed in _telemetryStats() and >= 1",
  _telemetryStats().rotate_failures >= 1,
  `stats=${JSON.stringify(_telemetryStats())}`,
);
// Heal: restore rename; rotation must retry and succeed on the very next
// flush — never permanently disabled by a past failure.
fsp.rename = origRename;
await withTelemetry("t_rotheal", async () => ({ ok: true }));
await _flushTelemetry();
check("g: .1 appears on the first flush after the fault clears", existsSync(ROTATED));
check(
  "g: ACTIVE shrank below cap after heal",
  statSync(ACTIVE).size < CAP,
  `size=${statSync(ACTIVE).size}`,
);
process.stderr.write = origStderrWrite;
check("g: no second escalation during/after heal", stderrMarks.length === 1);
harvest();

// --- h. tool name clamped at emit ---------------------------------------------
// L3b defect 2: executeTool's `name` is client-controlled and reaches the line
// raw on the NOT_FOUND path. Content-bearing or over-long names must hit disk
// only as "invalid_tool_name"; the emitted key-set is unchanged (case e lints).
const envBadTool = await executeTool("bad tool SECRET_MARKER2 xoxb-nope", {});
const longName = "a".repeat(200); // valid charset, over the 64-char bound
const envLongTool = await executeTool(longName, {});
await _flushTelemetry();
const rawH =
  readFileSync(ACTIVE, "utf8") + (existsSync(ROTATED) ? readFileSync(ROTATED, "utf8") : "");
const clampedH = rawH
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l))
  .filter((l) => l.tool === "invalid_tool_name");
check(
  "h: both envelopes still report NOT_FOUND misses",
  envBadTool.ok === false && envLongTool.ok === false,
);
check(
  "h: both bad names clamp to invalid_tool_name",
  clampedH.length === 2 && clampedH.every((l) => l.ok === false),
  `got ${clampedH.length}`,
);
check("h: raw sink never contains the marker", !rawH.includes("SECRET_MARKER2"));
check("h: 200-char name never reaches disk", !rawH.includes(longName));
harvest();

// --- i. byte-bounded pending queue ---------------------------------------------
// L3b defect 3: gate fsp.appendFile behind a promise so the write chain stalls,
// storm 300 calls against the 2048-byte pending budget, and require: drops
// counted, every call still returns normally, and the whole drop delta
// surfaces as dropped_since_last on the post-drain line(s).
await _flushTelemetry();
const origAppend = fsp.appendFile;
let releaseGate;
const gate = new Promise((r) => (releaseGate = r));
fsp.appendFile = async (...a) => {
  await gate;
  return origAppend(...a);
};
const droppedBeforeI = _telemetryStats().dropped;
const resultsI = await Promise.all(
  Array.from({ length: 300 }, () => withTelemetry("t_overflow", async () => ({ ok: true }))),
);
const dropDeltaI = _telemetryStats().dropped - droppedBeforeI;
check("i: dropped grew >= 200 under the byte bound", dropDeltaI >= 200, `delta=${dropDeltaI}`);
check(
  "i: every call still returned normally while dropping",
  resultsI.length === 300 && resultsI.every((r) => r && r.ok === true),
);
releaseGate();
await _flushTelemetry();
fsp.appendFile = origAppend;
await withTelemetry("t_after_overflow", async () => ({ ok: true }));
await _flushTelemetry();
const rawI =
  readFileSync(ACTIVE, "utf8") + (existsSync(ROTATED) ? readFileSync(ROTATED, "utf8") : "");
const linesI = rawI
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
// The first drained writeOne captured droppedSinceLast before/while the storm
// ran, so the delta may surface split across the first drained line(s) rather
// than all on t_after_overflow — sum over the post-drain lines is the honest
// "nothing silently lost" assertion (acceptance: next post-drain line(s)).
const surfacedI = linesI
  .filter(
    (l) =>
      (l.tool === "t_overflow" || l.tool === "t_after_overflow") &&
      Number.isInteger(l.dropped_since_last),
  )
  .reduce((s, l) => s + l.dropped_since_last, 0);
check(
  "i: post-drain line(s) surface dropped_since_last >= drop delta",
  surfacedI >= dropDeltaI,
  `surfaced=${surfacedI} delta=${dropDeltaI}`,
);
check(
  "i: t_after_overflow landed after the writer was restored",
  linesI.some((l) => l.tool === "t_after_overflow"),
);
harvest();

// --- j. SCOPE_BLOCKED path emits through the telemetry seam --------------------
// L3b defect 5: the pre-registry launch-identity gate (dispatch.js) must flow
// through withTelemetry like every other outcome. MEMORY_ROLE was deleted at
// the top of this file (before the dynamic imports), so the role is "agent".
const envScope = await executeTool("memory_distill_promote_fact", {});
check(
  "j: envelope is ok:false SCOPE_BLOCKED",
  envScope.ok === false && envScope.error?.code === "SCOPE_BLOCKED",
  `error=${JSON.stringify(envScope?.error)}`,
);
await _flushTelemetry();
const rawJ =
  readFileSync(ACTIVE, "utf8") + (existsSync(ROTATED) ? readFileSync(ROTATED, "utf8") : "");
const linesJ = rawJ
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l))
  .filter((l) => l.tool === "memory_distill_promote_fact");
check(
  "j: exactly one ok:false telemetry line for the SCOPE_BLOCKED call",
  linesJ.length === 1 && linesJ[0].ok === false,
  `got ${linesJ.length}: ${JSON.stringify(linesJ)}`,
);
harvest();

// --- e. forbidden-field lint over everything emitted --------------------------
// Runs LAST so it covers every line from cases a-f, including the case-b leak
// fixture that makes the regex falsifiable.
const ALLOWED_KEYS = new Set([
  "ts",
  "tool",
  "total_ms",
  "ok",
  "degraded_reason",
  "cold_start",
  "bytes_scanned",
  "stage_ms",
  "rss_delta_kb",
  "pid",
  "corr_id",
  "dropped_since_last",
]);
check("e: lint corpus is non-trivial", allLines.length > 200, `got ${allLines.length}`);
const badKeyLine = allLines.find((l) => !Object.keys(l).every((k) => ALLOWED_KEYS.has(k)));
check(
  "e: every line's keys ⊆ schema allowlist",
  badKeyLine === undefined,
  badKeyLine ? `offending line=${JSON.stringify(badKeyLine)}` : undefined,
);
const FORBIDDEN = /surrounding_context|query|content|message|text|token|xoxb|Bearer|authorization/i;
const m = allRaw.match(FORBIDDEN);
check(
  "e: raw telemetry never matches the forbidden-content regex",
  m === null,
  m ? `matched "${m[0]}"` : undefined,
);
// Falsifiability proof: the fixture string annotate() rejected in case b DOES
// match the regex — so a leaking implementation would fail the check above.
check(
  "e: lint regex would have caught the case-b fixture",
  FORBIDDEN.test("SECRET_MARKER xoxb-fake-token Bearer abc") &&
    FORBIDDEN.test('{"query":"SECRET_MARKER"}'),
);

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log(`\nAll telemetry assertions passed.`);
process.exit(0);
