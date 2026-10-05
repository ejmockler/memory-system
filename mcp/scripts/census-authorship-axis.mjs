#!/usr/bin/env node
// census-authorship-axis.mjs — A3 (memory-roots node codex-authorship-axis),
// two-pass since A8 (memory-roots node census-two-pass).
//
// READ-ONLY before/after census of the salience `authorship` component over
// the real source ledgers. Every row is scored TWICE, through two distinct
// module instances:
//
//   ON  = the working-tree mcp/lib/ingest/salience.js (A3 rule: speaker-
//         derived authorship for codex-cli / chat-claude-code, hoisted
//         consent for every other source), imported from ../lib.
//   OFF = a REAL second scoring run through the pre-A3 salience module:
//         the working-tree mcp/lib is copied into a mktemp snapshot, then
//         ONLY mcp/lib/ingest/salience.js inside the snapshot is overwritten
//         with `git show 2f65038:mcp/lib/ingest/salience.js` (blob 54affe9,
//         the 0.6-everywhere consent-only scorer). The snapshot is imported
//         via pathToFileURL(<snapshot path>) so the ESM module cache cannot
//         alias it to the ON module. The snapshot is never placed inside the
//         repo (exit 2 if it lands there).
//
// So the ONLY code difference between the two passes is authorshipScore.
// Stage-0 (stage0/codex-cli.js and siblings), validation.js, policy-events,
// content-index — all byte-identical across the passes, asserted for
// stage0/codex-cli.js by `git hash-object` before any row is scored. That is
// why whole-tree `git archive 2f65038` was rejected as the baseline: the
// working tree carries A6's uncommitted SCAFFOLD_USER_RE change
// (`codex_scaffold_regex_fallback` DROPs), so a whole-tree 2f65038 baseline
// would report Stage-0 drift as if it were an authorship effect.
//
// Consequently the EXPECTED per-row difference set is: decision — none;
// Stage-0 reason — none; PROMOTE components other than `authorship` — none.
// Any decision / reason / component mismatch this script reports is
// therefore a real A3 regression or a broken snapshot, never a documented
// legitimate difference. Route identity is MEASURED per row and per source,
// not asserted.
//
// What it never does
// ------------------
//   - never writes under storage/sources, ledgers/, or policy/. The policy
//     sink handed to scoreCandidate is an OBJECT with .push (a bare function
//     falls through to appendPolicyEvent and would write policy/). Each pass
//     gets its own sink object.
//   - never readFileSync's a whole ledger and never uses node:readline (a
//     U+2028 inside a row shatters it). Each ledger is tail-read by byte
//     offset (last 200 MB), the partial first line is discarded, and rows
//     are split on the \n BYTE — the discipline of
//     mcp/lib/synthesis/_ledger-stream.js.
//   - never lets Stage-0 side-effects reach the live tree. codex Stage-0
//     persists system_prompt dedup keys under STORAGE_DIR/dedup and
//     quarantines on DROP under QUARANTINE_BASE_DIR; the Stage-0 telemetry
//     sink binds STORAGE_DIR at import; chat-cc Stage-0 reads
//     STORAGE_DIR/sources/codex-cli.jsonl for its cross-source dedup index.
//     Env contract (A12, census-env-guard), enforced in section 0 BEFORE any
//     lib import binds config.js (config.js:40 reads STORAGE_BASE_DIR at
//     import; quarantine.js:206 reads QUARANTINE_BASE_DIR per call):
//       * an explicit STORAGE_BASE_DIR / QUARANTINE_BASE_DIR whose realpath
//         resolves inside the repo — or a TMPDIR that does — is REFUSED with
//         exit 2 (the nearest existing ancestor is realpath'd, so a not-yet-
//         created dir under the repo is refused too, and so is a worktree
//         under .claude/worktrees/);
//       * an unset dir makes the script re-exec itself with both pointed at
//         a fresh mkdtemp under TMPDIR;
//       * both mkdtemp dirs (the re-exec parent's, and the OFF snapshot in
//         section 2) are removed on exit, SIGINT and SIGTERM. The re-exec
//         parent spawns asynchronously and forwards SIGINT/SIGTERM to the
//         child, exiting with the child's code (130 / 143 on signal); the
//         row loop yields to the event loop every 500 rows so the child's
//         own handlers actually run.
//     The real source ledgers are opened by ABSOLUTE path under
//     <MEMORY_ROOT>/storage/sources/, never via STORAGE_DIR
//     (which now points at the temp dir).
//   - never runs a mutating git command: only `git show`, `git rev-parse`,
//     `git hash-object`.
//
// Side-channel hygiene: why one shared temp STORAGE_DIR cannot move a route
// ------------------------------------------------------------------------
// Both module instances bind the SAME temp STORAGE_BASE_DIR (config.js:40
// reads the env at import) and QUARANTINE_BASE_DIR (quarantine.js:206 reads
// the env per call). Sharing is safe because:
//   - codex system_prompt_hash dedup is a DOWNGRADE, not a DROP
//     (stage0/codex-cli.js:623): a repeat lands the system_prompt_replay
//     structural rung; it never changes the decision.
//   - each stage0/codex-cli.js instance hydrates its in-memory Set from disk
//     ONCE, at module load (stage0/codex-cli.js:454), i.e. from the empty
//     temp dir before any row is scored; afterwards markSystemPromptSeen
//     consults only its own Set, which both instances grow in the same row
//     order. So `structural` is identical across passes too (measured as
//     componentDrift below, expected 0).
//   - chat-cc cross-source dedup reads STORAGE_DIR/sources/codex-cli.jsonl,
//     which is empty in the temp dir for both passes (chat_cc_codex_dedup
//     never fires here; those rows PROMOTE instead of DROP — in both).
//   - the Stage-0 telemetry sink is append-only counters; nothing reads it
//     back during scoring.
//   - quarantine on DROP is append-only; nothing reads it back.
//   - the clock: scoreCandidate takes ctx.now for recencyScore; both passes
//     receive the same pinned value, otherwise `recency` drifts by the few
//     ms between the two calls and shows up as component drift.
//
// CLI
// ---
//   STORAGE_BASE_DIR=$(mktemp -d) QUARANTINE_BASE_DIR=$(mktemp -d) \
//     node mcp/scripts/census-authorship-axis.mjs --since 2026-09-02 --check
//
//   --since <ISO date>   keep rows with ts >= since (default 2026-09-02)
//   --check              exit non-zero unless ALL hold:
//                          * route counts identical OFF vs ON, every source
//                            (each map fed by its own scoreCandidate run)
//                          * per-row decision identical OFF vs ON
//                          * per-row Stage-0 reason identical on non-PROMOTE
//                            rows
//                          * per-row PROMOTE components other than
//                            `authorship` identical OFF vs ON
//                          * exact speaker mapping over PROMOTE rows — THE
//                            gate for the authorship rule (nodes/A3.md
//                            Orchestrator amendment): every codex-cli
//                            PROMOTE row with blank user_text scores
//                            CAPS.SALIENCE_AUTHORSHIP_AGENT under ON, and
//                            every codex-cli PROMOTE row with non-empty
//                            user_text scores 1.0 under ON
//                          * telegram and mail p50 score ON >= OFF
//                          * no scoreCandidate throw; tail window covers
//                            --since for every source
//                        The share of codex-cli rows at AGENT (>= 0.9 in the
//                        node's premise) is PRINTED ONLY, on two named
//                        populations (over PROMOTE rows; over PROMOTE rows +
//                        codex_tool_call_block DROPs). It never gates:
//                        Stage-0-DROPped rows never reach authorshipScore
//                        (FA3-3), so no authorship rule can move it.
//   --tail-mb <n>        tail window per ledger (default 200)

import {
  mkdtempSync,
  openSync,
  readSync,
  closeSync,
  statSync,
  cpSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
  realpathSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep, dirname, resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// 0. Env guard + re-exec. Must run BEFORE any lib import binds config.js.
//    Only node:fs / node:path / node:os are used here — no mcp/lib module is
//    loaded (statically or dynamically) until section 3, after this guard
//    and the section-2 snapshot check have passed.
// ---------------------------------------------------------------------------
// Real ledgers, by ABSOLUTE path — never through STORAGE_DIR.
const REPO = process.env.MEMORY_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function refuse(msg) {
  process.stderr.write(`[census] ${msg}\n`);
  process.exit(2);
}

// realpath of `p`, tolerating a tail that does not exist yet: env dirs such
// as join(tmp, "storage") are created by config.js consumers later, so walk
// up to the nearest existing ancestor, realpath THAT, and re-join the tail.
function realpathNearest(p) {
  let cur = resolve(p);
  const tail = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    tail.unshift(cur.slice(parent.length + 1));
    cur = parent;
  }
  return join(realpathSync(cur), ...tail);
}
// Same idiom as the section-2 snapshot check, so a worktree under
// .claude/worktrees/ (which realpaths under REPO) is refused too.
function insideRepo(p) {
  const r = realpathNearest(p);
  const root = realpathSync(REPO);
  return r === root || (r + sep).startsWith(root + sep);
}

// (a) TMPDIR first — it must be checked BEFORE the mkdtempSync below so an
//     in-repo TMPDIR never creates a dir inside the tree.
if (insideRepo(tmpdir())) {
  refuse(`TMPDIR ${tmpdir()} is inside the repo ${REPO}; refusing`);
}
// (b) An explicit env dir that resolves inside the repo would route Stage-0
//     dedup / telemetry / quarantine writes into production storage.
for (const name of ["STORAGE_BASE_DIR", "QUARANTINE_BASE_DIR"]) {
  const value = process.env[name];
  if (value && insideRepo(value)) {
    refuse(`${name}=${value} resolves inside the repo ${REPO}; refusing`);
  }
}
// (c) Unset → re-exec with both pointed at a fresh mkdtemp.
if (!process.env.STORAGE_BASE_DIR || !process.env.QUARANTINE_BASE_DIR) {
  const tmp = mkdtempSync(join(tmpdir(), "census-authorship-axis-"));
  // Belt-and-braces: whatever path leads to process.exit, the dir goes. The
  // primary removal is in the child's 'exit' handler below, which fires only
  // after the child has finished, so tmp is never pulled out from under it.
  process.on("exit", () => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  });
  const env = {
    ...process.env,
    STORAGE_BASE_DIR: process.env.STORAGE_BASE_DIR || join(tmp, "storage"),
    QUARANTINE_BASE_DIR:
      process.env.QUARANTINE_BASE_DIR || join(tmp, "quarantine"),
  };
  process.stderr.write(
    `[census] re-exec with STORAGE_BASE_DIR=${env.STORAGE_BASE_DIR} QUARANTINE_BASE_DIR=${env.QUARANTINE_BASE_DIR}\n`,
  );
  // ASYNC spawn, not spawnSync: a parent blocked in spawnSync never runs its
  // JS signal handlers (SIGTERM on it exited 1 and left the child running to
  // completion — wave-3 review). With the loop free, SIGINT/SIGTERM are
  // forwarded to the child; the parent exits only after the child has, with
  // the child's code (130 / 143 under the shell convention when the child
  // died by signal), and removes tmp on the way out.
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { env, stdio: "inherit" },
  );
  let forwarded = null;
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      forwarded = sig;
      try { child.kill(sig); } catch {}
    });
  }
  child.on("error", (e) => {
    process.stderr.write(`[census] re-exec failed: ${e && e.message ? e.message : e}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
    const sig = signal || forwarded;
    process.exit(code ?? (sig === "SIGINT" ? 130 : sig === "SIGTERM" ? 143 : 1));
  });
  // The rest of this module is the census itself and must not run in the
  // parent (its lib imports would bind config.js to the unset env). Park the
  // module here for good; the child's 'exit' event is the only way out.
  await new Promise(() => {});
}

// ---------------------------------------------------------------------------
// 1. Args.
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function argValue(flag, dflt) {
  const i = argv.indexOf(flag);
  if (i === -1 || i + 1 >= argv.length) return dflt;
  return argv[i + 1];
}
const SINCE = argValue("--since", "2026-09-02");
const CHECK = argv.includes("--check");
// Floor to an integer byte count: readSync's length/position must be
// integers, so a fractional --tail-mb (0.5) tripped ERR_OUT_OF_RANGE.
const tailMb = Number(argValue("--tail-mb", "200"));
if (!Number.isFinite(tailMb) || tailMb <= 0) {
  process.stderr.write(`--tail-mb must be a positive number, got ${argValue("--tail-mb", "200")}\n`);
  process.exit(2);
}
const TAIL_BYTES = Math.floor(tailMb * 1024 * 1024);
if (!Number.isFinite(Date.parse(SINCE))) {
  process.stderr.write(`--since must be an ISO date, got ${SINCE}\n`);
  process.exit(2);
}
const SINCE_MS = Date.parse(SINCE);

const SOURCES_DIR = join(REPO, "storage/sources");
const SOURCES = ["codex-cli", "chat-claude-code", "telegram", "mail"];

// ---------------------------------------------------------------------------
// 2. OFF baseline snapshot: working-tree mcp/lib + package.json copied into a
//    mktemp dir, node_modules symlinked (the A4 pattern,
//    maps/codex_admission_stage0_replay.mjs:88-90, but sourced from the
//    WORKING TREE so Stage-0 is byte-identical to the ON pass), then ONLY
//    salience.js overwritten with the 2f65038 blob. Read-only git.
// ---------------------------------------------------------------------------
const BASELINE_COMMIT = "2f65038";
const PINNED_FILE = "mcp/lib/ingest/salience.js";
const STAGE0_FILE = "mcp/lib/ingest/stage0/codex-cli.js";
function git(...args) {
  return execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).trim();
}

const snap = mkdtempSync(join(tmpdir(), "census-a8-baseline-"));
// The snapshot is per-run scratch; remove it on exit (any exit path: refuse()
// / process.exit, CHECK FAILED, normal completion, SIGINT, SIGTERM) so mktemp
// dirs do not leak. Registered on the line after mkdtempSync, BEFORE the
// inside-repo refuse() below, so that refusal path cleans up too.
process.on("exit", () => {
  try { rmSync(snap, { recursive: true, force: true }); } catch {}
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(sig === "SIGINT" ? 130 : 143));
if ((realpathSync(snap) + sep).startsWith(realpathSync(REPO) + sep)) {
  refuse(`baseline snapshot ${snap} is inside the repo ${REPO}; refusing`);
}
mkdirSync(join(snap, "mcp"));
cpSync(join(REPO, "mcp/lib"), join(snap, "mcp/lib"), { recursive: true });
cpSync(join(REPO, "mcp/package.json"), join(snap, "mcp/package.json"));
symlinkSync(join(REPO, "mcp/node_modules"), join(snap, "mcp/node_modules"));
const snapSalience = join(snap, PINNED_FILE);
writeFileSync(
  snapSalience,
  execFileSync("git", ["-C", REPO, "show", `${BASELINE_COMMIT}:${PINNED_FILE}`]),
);

// Pin and label. Both assertions run before any row is scored.
const wantSalienceBlob = git("rev-parse", `${BASELINE_COMMIT}:${PINNED_FILE}`);
const gotSalienceBlob = git("hash-object", snapSalience);
if (gotSalienceBlob !== wantSalienceBlob) {
  refuse(`snapshot salience.js blob ${gotSalienceBlob} != ${BASELINE_COMMIT}:${PINNED_FILE} ${wantSalienceBlob}`);
}
const stage0TreeBlob = git("hash-object", join(REPO, STAGE0_FILE));
const stage0SnapBlob = git("hash-object", join(snap, STAGE0_FILE));
if (stage0TreeBlob !== stage0SnapBlob) {
  refuse(`snapshot ${STAGE0_FILE} blob ${stage0SnapBlob} != working tree ${stage0TreeBlob}`);
}
const BASELINE_LABEL =
  `OFF = working-tree mcp/lib (stage0 blob ${stage0TreeBlob.slice(0, 7)}) ` +
  `with salience.js pinned to ${BASELINE_COMMIT} (blob ${wantSalienceBlob.slice(0, 7)})`;
process.stderr.write(`[census] ${BASELINE_LABEL}; snapshot at ${snap}\n`);

// ---------------------------------------------------------------------------
// 3. Lib imports (config.js now binds STORAGE_DIR to the temp dir — in BOTH
//    module instances, see "Side-channel hygiene" above).
// ---------------------------------------------------------------------------
const { scoreCandidate, _internals } = await import("../lib/ingest/salience.js");
// Baseline: ALWAYS via the snapshot path. Importing "../lib/ingest/salience.js"
// again would hand back the cached ON module.
const baseline = await import(pathToFileURL(snapSalience).href);
if (typeof baseline.scoreCandidate !== "function" || !baseline._internals) {
  refuse("baseline module lacks scoreCandidate / _internals");
}
if (baseline.scoreCandidate === scoreCandidate) {
  refuse("baseline scoreCandidate is the ON function — module cache aliased the snapshot");
}
// Cheap proofs that the baseline is the pre-A3 scorer. 2f65038's signature
// is authorshipScore(consentBasis): arity 1 (necessary — the A3 signature
// `authorshipScore(event, { speakerEnabled } = {})` also reports 1 — so the
// behavioural check is the discriminating one: the pre-A3 scorer accepts a
// bare consent string and does NOT read an event object).
const baselineAuthorship = baseline._internals.authorshipScore;
if (baselineAuthorship.length !== 1) {
  refuse(`baseline authorshipScore.length ${baselineAuthorship.length} != 1 (expected the 2f65038 authorshipScore(consentBasis))`);
}
if (baselineAuthorship("first_party") !== 1.0 || baselineAuthorship({ consent_basis: "first_party" }) === 1.0) {
  refuse("baseline authorshipScore does not behave like 2f65038's consent-string scorer");
}
const { CAPS } = await import("../lib/validation.js");
// TOOL_BLOCK_RE is surfaced on the codex Stage-0 module's `_internals`
// export (stage0/codex-cli.js:684-693), not as a named export.
const { _internals: codexStage0Internals } = await import("../lib/ingest/stage0/codex-cli.js");
const { TOOL_BLOCK_RE } = codexStage0Internals;
if (!(TOOL_BLOCK_RE instanceof RegExp)) {
  refuse("stage0/codex-cli.js _internals.TOOL_BLOCK_RE is not a RegExp");
}
// weightedScore is kept ONLY for the optional weights-identity cross-check
// (ON weights applied to the OFF authorship must reproduce the OFF score).
const { weightedScore } = _internals;
const AGENT = CAPS.SALIENCE_AUTHORSHIP_AGENT;

// ---------------------------------------------------------------------------
// 4. Tail-read by byte offset; split on the \n byte; parse per line.
// ---------------------------------------------------------------------------
function tailRows(path, sinceMs) {
  const out = [];
  let size = 0;
  try {
    size = statSync(path).size;
  } catch (e) {
    return { rows: out, size: 0, tailRows: 0, firstTs: null, error: e.message };
  }
  const start = Math.max(0, size - TAIL_BYTES);
  const fd = openSync(path, "r");
  let buf;
  try {
    buf = Buffer.allocUnsafe(size - start);
    let pos = 0;
    while (pos < buf.length) {
      const n = readSync(fd, buf, pos, buf.length - pos, start + pos);
      if (n <= 0) break;
      pos += n;
    }
    buf = buf.subarray(0, pos);
  } finally {
    closeSync(fd);
  }
  let cursor = 0;
  if (start > 0) {
    // Discard the partial first line.
    const nl = buf.indexOf(10, 0);
    cursor = nl === -1 ? buf.length : nl + 1;
  }
  let tailRowCount = 0;
  let firstTs = null;
  while (cursor < buf.length) {
    let nl = buf.indexOf(10, cursor);
    if (nl === -1) nl = buf.length;
    const line = buf.subarray(cursor, nl);
    cursor = nl + 1;
    if (line.length === 0) continue;
    let row;
    try {
      row = JSON.parse(line.toString("utf8"));
    } catch {
      continue;
    }
    if (row == null || typeof row !== "object") continue;
    tailRowCount += 1;
    const ts = typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
    if (firstTs == null && Number.isFinite(ts)) firstTs = row.ts;
    if (!Number.isFinite(ts) || ts < sinceMs) continue;
    out.push(row);
  }
  return { rows: out, size, tailRows: tailRowCount, firstTs, error: null };
}

// ---------------------------------------------------------------------------
// 5. Score — every row through BOTH modules.
// ---------------------------------------------------------------------------
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}
const r4 = (v) => (v == null ? "-" : Number(v).toFixed(4));
const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);

// Pinned once so every row, in both passes, sees the same `now`.
const CENSUS_NOW_MS = Date.now();
const YIELD_EVERY = 500;
const MISMATCH_EXAMPLE_CAP = 20;
const mismatchExamples = [];
function noteMismatch(kind, source, row, resOn, resOff, extra) {
  if (mismatchExamples.length >= MISMATCH_EXAMPLE_CAP) return;
  mismatchExamples.push({
    kind,
    source,
    ts: row.ts,
    source_msg_id: row.source_msg_id ?? row.id ?? null,
    on: `${resOn.decision}${resOn.reason ? "/" + resOn.reason : ""}`,
    off: `${resOff.decision}${resOff.reason ? "/" + resOff.reason : ""}`,
    ...(extra || {}),
  });
}

const results = {};
for (const source of SOURCES) {
  const path = join(SOURCES_DIR, `${source}.jsonl`);
  const t0 = Date.now();
  const { rows, size, tailRows: tailRowCount, firstTs, error } = tailRows(path, SINCE_MS);
  const stat = {
    source,
    size,
    tailRows: tailRowCount,
    firstTs,
    error,
    coverageOk: firstTs != null && Date.parse(firstTs) <= SINCE_MS,
    rows: rows.length,
    compared: 0,
    decisionMismatches: 0,
    reasonMismatches: 0,
    componentDrift: 0,
    weightsIdentityMismatch: 0,
    routesOn: new Map(),
    routesOff: new Map(),
    dropReasons: new Map(),
    authOn: new Map(),
    authOff: new Map(),
    scoresOn: [],
    scoresOff: [],
    // codex-cli only
    userTurn: 0,
    assistantOnly: 0,
    toolBlock: 0,
    toolBlockDropped: 0,
    passUserTurn: 0,
    passUserTurnAt1: 0,
    passAssistantOnly: 0,
    passAtAgent: 0,
    scoreErrors: 0,
    scoreErrorExample: null,
  };
  // Policy sinks: OBJECTS with .push so emit helpers never reach
  // appendPolicyEvent. One per pass. Counts only; never retains the event.
  const sinkOn = { n: 0, push() { this.n += 1; } };
  const sinkOff = { n: 0, push() { this.n += 1; } };
    // One clock for both passes: scoreCandidate reads ctx.now (salience.js:896,
  // "test injection; defaults to Date.now") for recencyScore. Without it the
  // OFF call lands a few ms after the ON call on the same row and `recency`
  // drifts at the 1e-8 level (measured: 1,921 of 14,135 PROMOTE rows).
  const ctxOn = { embedding_mrl_768: null, hnsw: null, contentIndex: null, policyEventSink: sinkOn, now: CENSUS_NOW_MS };
  const ctxOff = { embedding_mrl_768: null, hnsw: null, contentIndex: null, policyEventSink: sinkOff, now: CENSUS_NOW_MS };

  // Yield to libuv every YIELD_EVERY rows. ctxOn/ctxOff carry no embedder or
  // hnsw and Stage-0 dispatch is cached, so every `await` below settles as a
  // microtask and the loop otherwise never returns to the event loop — the
  // SIGINT/SIGTERM handlers above were unreachable for the whole run (kill
  // -INT ignored for 136-288 s; only SIGKILL stopped it and leaked the
  // snapshot). A setImmediate turn delivers pending signals. It does not
  // reorder scoring (rows are still processed strictly in ledger order, ON
  // then OFF per row) and CENSUS_NOW_MS is pinned once above, so the report
  // is byte-identical with or without the yield.
  let rowsSinceYield = 0;
  for (const row of rows) {
    if (++rowsSinceYield >= YIELD_EVERY) {
      rowsSinceYield = 0;
      await new Promise((r) => setImmediate(r));
    }
    const rc = row.raw_content && typeof row.raw_content === "object" ? row.raw_content : {};
    const userText = typeof rc.user_text === "string" ? rc.user_text : "";
    const assistantText = typeof rc.assistant_text === "string" ? rc.assistant_text : "";
    const hasUser = userText.trim().length > 0;
    let isToolBlock = false;
    if (source === "codex-cli") {
      if (hasUser) stat.userTurn += 1;
      else stat.assistantOnly += 1;
      isToolBlock = !hasUser && TOOL_BLOCK_RE.test(assistantText);
      if (isToolBlock) stat.toolBlock += 1;
    }
    let resOn;
    let resOff;
    try {
      resOn = await scoreCandidate(row, ctxOn);
      resOff = await baseline.scoreCandidate(row, ctxOff);
    } catch (e) {
      stat.scoreErrors += 1;
      if (stat.scoreErrorExample == null) stat.scoreErrorExample = String(e && e.message ? e.message : e);
      continue;
    }
    stat.compared += 1;
    const dOn = resOn.decision;
    const dOff = resOff.decision;
    inc(stat.routesOn, dOn);
    inc(stat.routesOff, dOff);
    if (dOn !== dOff) {
      stat.decisionMismatches += 1;
      noteMismatch("decision", source, row, resOn, resOff);
    } else if (dOn !== "PROMOTE" && (resOn.reason || "") !== (resOff.reason || "")) {
      stat.reasonMismatches += 1;
      noteMismatch("reason", source, row, resOn, resOff);
    }
    if (dOn === "DROP" || dOn === "REDACT_DROP") {
      inc(stat.dropReasons, resOn.reason || dOn);
      if (isToolBlock) stat.toolBlockDropped += 1;
    }
    if (dOn !== "PROMOTE" || dOff !== "PROMOTE") continue;

    const aOn = resOn.components.authorship;
    const aOff = resOff.components.authorship;
    const scoreOn = resOn.score;
    const scoreOff = resOff.score;
    // Every component other than authorship must be equal across passes
    // (structural, recency, content_mass, source_prior, novelty, ...).
    const keys = new Set([...Object.keys(resOn.components), ...Object.keys(resOff.components)]);
    let drifted = null;
    for (const k of keys) {
      if (k === "authorship") continue;
      if (resOn.components[k] !== resOff.components[k]) {
        drifted = k;
        break;
      }
    }
    if (drifted != null) {
      stat.componentDrift += 1;
      noteMismatch("component", source, row, resOn, resOff, {
        component: drifted,
        onValue: resOn.components[drifted],
        offValue: resOff.components[drifted],
      });
    }
    // Weights identity (printed, not gated): ON weights over the OFF
    // authorship reproduce the OFF score exactly.
    if (weightedScore({ ...resOn.components, authorship: aOff }) !== scoreOff) {
      stat.weightsIdentityMismatch += 1;
    }
    inc(stat.authOn, aOn);
    inc(stat.authOff, aOff);
    stat.scoresOn.push(scoreOn);
    stat.scoresOff.push(scoreOff);
    if (source === "codex-cli") {
      if (hasUser) {
        stat.passUserTurn += 1;
        if (aOn === 1.0) stat.passUserTurnAt1 += 1;
      } else {
        stat.passAssistantOnly += 1;
      }
      if (aOn === AGENT) stat.passAtAgent += 1;
    }
  }
  stat.scoresOn.sort((a, b) => a - b);
  stat.scoresOff.sort((a, b) => a - b);
  stat.sinkEventsOn = sinkOn.n;
  stat.sinkEventsOff = sinkOff.n;
  stat.elapsedMs = Date.now() - t0;
  results[source] = stat;
  process.stderr.write(
    `[census] ${source}: ${rows.length} rows since ${SINCE} (tail ${tailRowCount} rows from ${firstTs}), ` +
      `${stat.compared} compared on/off, ${stat.decisionMismatches}/${stat.reasonMismatches}/${stat.componentDrift} decision/reason/component mismatches, ${stat.elapsedMs} ms\n`,
  );
}

const totals = SOURCES.reduce(
  (t, s) => {
    const r = results[s];
    t.compared += r.compared;
    t.decisionMismatches += r.decisionMismatches;
    t.reasonMismatches += r.reasonMismatches;
    t.componentDrift += r.componentDrift;
    t.weightsIdentityMismatch += r.weightsIdentityMismatch;
    return t;
  },
  { compared: 0, decisionMismatches: 0, reasonMismatches: 0, componentDrift: 0, weightsIdentityMismatch: 0 },
);
const perSourceCompared = SOURCES.map((s) => `${s} ${results[s].compared}`).join(", ");
const TWO_PASS_LINE =
  `two-pass: ${totals.compared} rows compared (per-source: ${perSourceCompared}), ` +
  `${totals.decisionMismatches} decision mismatches, ${totals.reasonMismatches} reason mismatches, ` +
  `${totals.componentDrift} component drifts; baseline = ${BASELINE_LABEL}`;

// ---------------------------------------------------------------------------
// 6. Report.
// ---------------------------------------------------------------------------
const fmtMap = (m) =>
  [...m.entries()]
    .sort((a, b) => (typeof a[0] === "number" ? a[0] - b[0] : String(a[0]).localeCompare(String(b[0]))))
    .map(([k, v]) => `${k}:${v}`)
    .join(" ") || "-";
const routeCell = (m) =>
  `${m.get("PROMOTE") || 0} / ${m.get("CORROBORATE") || 0} / ${(m.get("DROP") || 0) + (m.get("REDACT_DROP") || 0)}`;

const lines = [];
lines.push(`### Authorship-axis census — since ${SINCE}, flag OFF (pre-A3) vs ON (A3), SALIENCE_AUTHORSHIP_AGENT=${AGENT}`);
lines.push("");
lines.push("| source | rows | PROMOTE/CORROB/DROP off | PROMOTE/CORROB/DROP on | authorship hist off | authorship hist on | p10/p50/p90 off | p10/p50/p90 on |");
lines.push("|---|---|---|---|---|---|---|---|");
for (const source of SOURCES) {
  const s = results[source];
  lines.push(
    `| ${source} | ${s.rows} | ${routeCell(s.routesOff)} | ${routeCell(s.routesOn)} | ${fmtMap(s.authOff)} | ${fmtMap(s.authOn)} | ` +
      `${r4(percentile(s.scoresOff, 0.1))} / ${r4(percentile(s.scoresOff, 0.5))} / ${r4(percentile(s.scoresOff, 0.9))} | ` +
      `${r4(percentile(s.scoresOn, 0.1))} / ${r4(percentile(s.scoresOn, 0.5))} / ${r4(percentile(s.scoresOn, 0.9))} |`,
  );
}
lines.push("");
lines.push("| source | ledger bytes | tail rows | tail first ts | covers --since | Stage-0 DROP reasons (ON pass) | policy events sunk on / off (never written) |");
lines.push("|---|---|---|---|---|---|---|");
for (const source of SOURCES) {
  const s = results[source];
  lines.push(`| ${source} | ${s.size} | ${s.tailRows} | ${s.firstTs || "-"} | ${s.coverageOk ? "yes" : "NO"} | ${fmtMap(s.dropReasons)} | ${s.sinkEventsOn} / ${s.sinkEventsOff} |`);
}
lines.push("");
lines.push("| source | rows compared on/off | decision mismatches | reason mismatches | component drifts (non-authorship) | weights-identity mismatches (printed only) |");
lines.push("|---|---|---|---|---|---|");
for (const source of SOURCES) {
  const s = results[source];
  lines.push(`| ${source} | ${s.compared} | ${s.decisionMismatches} | ${s.reasonMismatches} | ${s.componentDrift} | ${s.weightsIdentityMismatch} |`);
}
lines.push("");
lines.push(TWO_PASS_LINE);
if (mismatchExamples.length > 0) {
  lines.push(`first ${mismatchExamples.length} mismatch examples (cap ${MISMATCH_EXAMPLE_CAP}):`);
  for (const ex of mismatchExamples) lines.push(`- ${JSON.stringify(ex)}`);
}
const c = results["codex-cli"];
lines.push("");
lines.push("codex-cli speaker split (all rows since --since):");
lines.push(`- user-turn rows (user_text non-blank): ${c.userTurn}; assistant-only rows: ${c.assistantOnly}`);
lines.push(`- pure TOOL_BLOCK_RE rows (assistant-only): ${c.toolBlock} — Stage-0 DROP'd ${c.toolBlockDropped} of them (codex_tool_call_block, commit 2f65038; NOT an A3 effect; identical in both passes)`);
lines.push(`- PROMOTE rows: ${c.passUserTurn + c.passAssistantOnly} (user-turn ${c.passUserTurn}, assistant-only ${c.passAssistantOnly})`);
const codexPromote = c.passUserTurn + c.passAssistantOnly;
const pct = (num, den) => (den > 0 ? ((100 * num) / den).toFixed(1) + "%" : "-");
// Two populations for the "share of codex rows at the agent rung". Both are
// STATISTICS, NOT GATED (nodes/A3.md Orchestrator amendment): Stage-0-
// DROPped rows never reach authorshipScore (FA3-3), so no authorship rule
// can move either number; the gate is the exact speaker mapping below.
//   over PROMOTE rows: the PASS population of THIS census (post-2f65038,
//     where codex_tool_call_block has already removed the pure envelope
//     rows — all assistant-only — from the PASS set);
//   over PROMOTE rows + codex_tool_call_block DROPs: the population node
//     A3's premise measured (Premise 3: 92.0% of codex source rows are
//     assistant-only at a 99.4% Stage-0 pass rate). Those DROPs are
//     assistant-only by definition (isEmpty(userText) guard,
//     stage0/codex-cli.js:597).
lines.push(`- share at authorship ${AGENT} under ON over PROMOTE rows: ${c.passAtAgent} / ${codexPromote} = ${pct(c.passAtAgent, codexPromote)} (statistic, not gated)`);
lines.push(`- share at authorship ${AGENT} under ON over PROMOTE rows + codex_tool_call_block DROPs: ${c.passAtAgent + c.toolBlockDropped} / ${codexPromote + c.toolBlockDropped} = ${pct(c.passAtAgent + c.toolBlockDropped, codexPromote + c.toolBlockDropped)} (statistic, not gated)`);
lines.push(`- PROMOTE assistant-only rows at authorship ${AGENT} under ON: ${c.passAtAgent} / ${c.passAssistantOnly} — exact speaker mapping: ${c.passAtAgent === c.passAssistantOnly ? "yes" : "NO"} (gated)`);
lines.push(`- PROMOTE user-turn rows at authorship 1.0 under ON: ${c.passUserTurnAt1} / ${c.passUserTurn} — exact speaker mapping: ${c.passUserTurnAt1 === c.passUserTurn ? "yes" : "NO"} (gated)`);
lines.push("");
lines.push(
  "Route columns are MEASURED: OFF is a real second scoring run of every row through the pinned pre-A3 salience module " +
    "(2f65038 salience.js over a working-tree mcp/lib snapshot, so the only code difference is authorshipScore). " +
    "Expected difference set is empty for decisions, Stage-0 reasons, and non-authorship components; any mismatch is a real A3 regression or a broken snapshot.",
);
process.stdout.write(lines.join("\n") + "\n");

// ---------------------------------------------------------------------------
// 7. --check gate (nodes/A3.md Orchestrator amendment, node A8).
// ---------------------------------------------------------------------------
if (CHECK) {
  const failures = [];
  for (const source of SOURCES) {
    const s = results[source];
    if (s.error) failures.push(`${source}: ledger unreadable (${s.error})`);
    if (!s.coverageOk) failures.push(`${source}: tail window does not reach --since (first ts ${s.firstTs})`);
    for (const k of new Set([...s.routesOn.keys(), ...s.routesOff.keys()])) {
      if ((s.routesOn.get(k) || 0) !== (s.routesOff.get(k) || 0)) {
        failures.push(`${source}: route ${k} differs off=${s.routesOff.get(k) || 0} on=${s.routesOn.get(k) || 0}`);
      }
    }
    if (s.decisionMismatches !== 0) failures.push(`${source}: ${s.decisionMismatches} rows with decision OFF != ON`);
    if (s.reasonMismatches !== 0) failures.push(`${source}: ${s.reasonMismatches} non-PROMOTE rows with Stage-0 reason OFF != ON`);
    if (s.componentDrift !== 0) failures.push(`${source}: ${s.componentDrift} PROMOTE rows with a non-authorship component OFF != ON`);
    if (s.scoreErrors > 0) failures.push(`${source}: ${s.scoreErrors} rows threw in scoreCandidate (first: ${s.scoreErrorExample})`);
  }
  if (codexPromote === 0) failures.push("codex-cli: no PROMOTE rows to measure");
  // THE authorship gate: speaker mapping must be EXACT on the PROMOTE set —
  // every assistant-only row at AGENT, every user-turn row at 1.0. The
  // >= 0.9 shares above are printed only.
  if (c.passAtAgent !== c.passAssistantOnly) {
    failures.push(`codex-cli: ${c.passAssistantOnly - c.passAtAgent} PROMOTE assistant-only rows not at authorship ${AGENT} under ON`);
  }
  if (c.passUserTurnAt1 !== c.passUserTurn) {
    failures.push(`codex-cli: ${c.passUserTurn - c.passUserTurnAt1} PROMOTE user-turn rows not at 1.0 under ON`);
  }
  for (const source of ["telegram", "mail"]) {
    const s = results[source];
    const on = percentile(s.scoresOn, 0.5);
    const off = percentile(s.scoresOff, 0.5);
    if (on == null || off == null) failures.push(`${source}: no PROMOTE rows for p50`);
    else if (on < off) failures.push(`${source}: p50 on ${on} < off ${off}`);
  }
  if (failures.length > 0) {
    process.stderr.write("CHECK FAILED:\n" + failures.map((f) => `  - ${f}`).join("\n") + "\n" + TWO_PASS_LINE + "\n");
    process.exit(1);
  }
  process.stderr.write(`CHECK OK\n${TWO_PASS_LINE}\n`);
}
