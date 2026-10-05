// cursor-stamp-class.test.mjs — c3-cursor-stamp-class regression gate.
//
// THE DEFECT CLASS: `connectors/<source>/state.json`.`last_cursor_advance_ts`
// is the sensor two classifiers read to decide whether a connector has gone
// `stale`:
//   - ConnectorBase._healthFromState  — mcp/lib/connectors/index.js:601,607-611
//   - metadataFromState               — mcp/lib/connectors/index.js:701,707-711
// Both compare its age to CAPS.CONNECTOR_HEALTH_STALE_SECONDS = 3600
// (mcp/lib/validation.js:370). A connector that stamps the field with now() on
// EVERY poll — whether or not any cursor moved — can therefore never go stale:
// the sensor refreshes itself forever.
//
// The failure shape, as an illustrative connectors/slack/state.json (a
// synthetic example, not a captured file):
//   {"workspaces":{}, "last_appended_ts":null, "last_appended_id":null,
//    "last_cursor_advance_ts":"2026-01-01T00:00:02.013Z",
//    "error_count":1000, "last_error_kind":"slack_auth_invalid_auth",
//    "last_error_ts":"2026-01-01T00:00:02.000Z"}
// When Slack's OAuth token is invalid, resolveSelfUserId() returns null, the
// workspace is skipped, `workspaces` is still {}, no row has EVER been
// appended — and the tail write still stamps a fresh "advance" milliseconds
// after tagging yet another consecutive auth error.
//
// THE FIX SHAPE (ported from mcp/lib/connectors/telegram.js:255-264, the one
// source that already got this right):
//     const cursorAdvanced = <real progress this poll>;
//     const carriedAdvanceTs =
//       typeof state.last_cursor_advance_ts === "string" ? state.last_cursor_advance_ts : null;
//     ... last_cursor_advance_ts: cursorAdvanced ? nowTs : carriedAdvanceTs,
// `last_polled_ts` stays UNCONDITIONAL at every site — it means "we ran"
// (telegram.js:253-254) and no classifier reads it.
//
// TEST SHAPE. Every behavioural case has the same three beats:
//   1. seed state.json with last_cursor_advance_ts = "2026-01-01T00:00:00.000Z"
//      (a literal no injected now() in this file can produce),
//   2. run a poll that makes NO progress,
//   3. assert the field is byte-identical afterwards.
// Each no-progress case is paired with a positive control that makes REAL
// progress and asserts the stamp moved — without the pair, a hard-coded
// `null` would satisfy the no-progress half and prove nothing.
//
//   T1 slack      — failing-auth poll must not stamp (the live production shape)
//   T2 slack      — a real channel-cursor advance DOES stamp
//   T3 screentime — zero-row page must not stamp (screentime.js rows.length===0)
//   T4 screentime — a page that advances last_z_pk DOES stamp
//   T5 codex-cli  — poll over an EMPTY sessions dir must not stamp
//   T6 codex-cli  — one rollout file with one ingestible turn DOES stamp
//   T7 git-log    — poll over a root with no git repos must not stamp
//   T8 CLASS GUARD    — static scan of mcp/lib/connectors/*.js: no UNSAFE site
//   T9 ANTI-VACUITY   — the guard classifier itself, on synthetic strings
//   T10 git-log   — QUARANTINE ADVANCE: a repo whose only commit is an
//                   initial-commit variant writes per_repo_cursors durably, so
//                   the stamp MUST move (the wave-1 refutation's repro)
//   T11 git-log   — TICK-DEDUP SKIP-PAST: a within-tick re-walk reaches the
//                   already-quarantined-this-tick branch, whose write is the
//                   durable one; the stamp MUST move
//   T12 git-log   — IDEMPOTENCY: re-polling with nothing new, and re-walking
//                   the SAME commit, must NOT stamp (assignment != advance)
//   T13 MUTATION-SITE PARITY — static: every cursor-map mutation site in
//                   git-log-local.js / codex-cli.js / slack.js is covered by a
//                   `cursorAdvanced = true`, directly or via one shared helper
//   T13b/T13c git-log — the two durable maps each have ONE write site inside
//                   their helper: perRepoCursors → noteRepoCursor (T13b),
//                   perRepoTips → noteRepoTips (T13c, D3); both proto-safe and
//                   change-detecting (assignment != advance)
//
// WAVE-2 LENS — assertDurableCursorInvariant(). Wave 1 gated only ONE of
// git-log-local.js's THREE `perRepoCursors[...] =` sites, so two durable cursor
// advances still carried a stale stamp. Every behavioural case now runs a shared
// invariant: if ANY persisted cursor-progress field moved
// (per_repo_cursors / workspaces / last_z_pk / per_session_cursors /
// per_session_offsets), last_cursor_advance_ts MUST have moved off the seeded
// literal — regardless of which site caused it.
//
// HERMETICITY: MEMORY_ROOT + the four per-dir overrides are bound to an
// mkdtemp root BEFORE the first dynamic import; fetch is stubbed via
// opts.fetchImpl so no socket is ever opened toward slack.com; every clock is
// injected as a literal (nothing is asserted against a bare Date.now()).
// Production ledgers/memory.jsonl is {mtimeMs,size}-snapshotted pre/post and
// the final test fails if it drifts — the recipe at
// mcp/test/slack-connector.test.mjs:56-61,442-452.
//
// DELIBERATELY DOES NOT import ./_hermetic-daemon-skip.mjs. That helper's own
// REG comment records that its "0 passed, 0 failed (skipped — daemon-active)"
// exit-0 produced three VACUOUS gate passes in wave 1. This file is a gate; it
// must never be able to pass without asserting.
//
// Run: node --test test/cursor-stamp-class.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Hermetic root + env wiring — MUST precede dynamic imports.
// (verbatim recipe from mcp/test/slack-connector.test.mjs:41-61)
// ---------------------------------------------------------------------------
const TEST_ROOT = mkdtempSync(join(tmpdir(), "cursor-stamp-class-"));
mkdirSync(join(TEST_ROOT, "policy"), { recursive: true });
mkdirSync(join(TEST_ROOT, "ledgers"), { recursive: true });
mkdirSync(join(TEST_ROOT, "storage", "sources"), { recursive: true });
mkdirSync(join(TEST_ROOT, "connectors"), { recursive: true });
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
process.env.CONNECTORS_BASE_DIR = join(TEST_ROOT, "connectors");
// Pin codex consent_basis so the case does not depend on operator env.
process.env.CODEX_CLI_CONSENT_BASIS = "first_party";
process.on("exit", () => {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
});

// Production-safety snapshot (slack-connector.test.mjs:56-61).
const PROD_LEDGER = join(homedir(), "memory-system", "ledgers", "memory.jsonl");
let prodBefore = null;
try {
  const st = statSync(PROD_LEDGER);
  prodBefore = { mtimeMs: st.mtimeMs, size: st.size };
} catch { /* absent on a machine without the production tree */ }

// ---------------------------------------------------------------------------
// Dynamic imports — after the env binding above.
// ---------------------------------------------------------------------------
const { SlackConnector } = await import("../lib/connectors/slack.js");
const { ScreenTimeConnector } = await import("../lib/connectors/screentime.js");
const { CodexCliConnector } = await import("../lib/connectors/codex-cli.js");
// NOTE: the exported class is `GitLogConnector` (git-log-local.js:846) — the
// node spec named it `GitLogLocalConnector`, which does not exist.
const { GitLogConnector } = await import("../lib/connectors/git-log-local.js");
const { DatabaseSync } = await import("node:sqlite");

// ---------------------------------------------------------------------------
// Shared literals. SEEDED_TS is unreachable by any now() this file injects, so
// "still SEEDED_TS" is unambiguous evidence the value was carried, not restamped.
// ---------------------------------------------------------------------------
const SEEDED_TS = "2026-01-01T00:00:00.000Z";
const NOW_TS = "2026-06-01T12:00:00.000Z";
const nowFn = () => NOW_TS;

const CONNECTORS_LIB_DIR = join(import.meta.dirname, "..", "lib", "connectors");

function caseDirs(name) {
  const cursorPath = join(TEST_ROOT, "connectors", name, "state.json");
  const sourceLedgerPath = join(TEST_ROOT, "storage", "sources", `${name}.jsonl`);
  mkdirSync(join(TEST_ROOT, "connectors", name), { recursive: true });
  return { cursorPath, sourceLedgerPath };
}

// ---------------------------------------------------------------------------
// THE WAVE-2 LENS — assertDurableCursorInvariant.
//
// Wave 1's gate asserted, per connector, "this SPECIFIC no-progress poll did not
// stamp". That is site-blind: git-log-local.js mutates `perRepoCursors` at THREE
// places and wave 1 gated only the third, so a poll that durably advanced
// per_repo_cursors from {} to a real HEAD sha still shipped a stale stamp and no
// assertion noticed. This invariant is site-blind in the other direction: it
// reads only the PERSISTED state, so any durable cursor movement — whichever
// line caused it — must be accompanied by a stamp that left the seeded literal.
//
// The fields are the per-connector cursor maps actually persisted in
// connectors/<source>/state.json:
//   per_repo_cursors     git-log-local.js:2072
//   per_repo_ref_tips    git-log-local.js (D1 tip frontier; heavy sidecar,
//                        merged in by readCursor, mutated only in noteRepoTips —
//                        the single write site is pinned by T13c)
//   workspaces           slack.js (writeChannelCursor, :235)
//   last_z_pk            screentime.js:1049 (zero-row carry) and :1207 (end of page)
//   per_session_cursors  codex-cli.js
//   per_session_offsets  codex-cli.js
// last_polled_ts / last_appended_ts are deliberately NOT here: the first is
// unconditional by design (telegram.js:253-254) and the second is not a cursor.
const DURABLE_CURSOR_FIELDS = [
  "per_repo_cursors",
  "per_repo_ref_tips",
  "workspaces",
  "last_z_pk",
  "per_session_cursors",
  "per_session_offsets",
];

function _stableJson(v) {
  const s = JSON.stringify(v);
  return s === undefined ? "undefined" : s;
}

function assertDurableCursorInvariant(before, after, label) {
  assert.ok(before && typeof before === "object", `${label}: seeded state missing`);
  assert.ok(after && typeof after === "object", `${label}: post-poll state missing`);
  const moved = [];
  for (const f of DURABLE_CURSOR_FIELDS) {
    const b = _stableJson(before[f]);
    const a = _stableJson(after[f]);
    if (b !== a) moved.push(`${f}: ${b} -> ${a}`);
  }
  if (moved.length === 0) return; // nothing durable moved; the stamp may sit still
  assert.notEqual(
    after.last_cursor_advance_ts,
    before.last_cursor_advance_ts,
    `${label}: DURABLE CURSOR PROGRESS WITH A STALE STAMP. ` +
      `Persisted cursor state moved [${moved.join("; ")}] but last_cursor_advance_ts is ` +
      `still ${JSON.stringify(after.last_cursor_advance_ts)}. Some mutation site of the ` +
      `cursor map is not setting cursorAdvanced — find it and gate it.`,
  );
}

// ---------------------------------------------------------------------------
// Hermetic git fixtures. Created ONLY inside TEST_ROOT; never under the
// production ledgers/ indices/ storage/ connectors/ trees. Identity, default
// branch and signing are pinned repo-locally so the run does not depend on the
// operator's ~/.gitconfig. Recipe mirrors buildSyntheticRepo in
// mcp/test/git-log-local-connector.test.mjs:93-108.
// ---------------------------------------------------------------------------
const FIXTURE_AUTHOR = { name: "Fixture Operator", email: "operator@example.com" };

function gitIn(repoDir, args, env) {
  const r = spawnSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

// initialCommitOnlyRepo — a repo whose ONE and ONLY commit is a root commit
// (parents === []) with subject "Initial commit". That combination makes
// isInitialCommitVariant (git-log-local.js:618-628) true and initialCommitSuffix
// (:597-604) null, so pollOnce takes the QUARANTINE branch — the path whose
// cursor write wave 1 left ungated.
function initialCommitOnlyRepo(repoDir) {
  mkdirSync(repoDir, { recursive: true });
  gitIn(repoDir, ["init", "-q", "-b", "main"]);
  gitIn(repoDir, ["config", "user.name", FIXTURE_AUTHOR.name]);
  gitIn(repoDir, ["config", "user.email", FIXTURE_AUTHOR.email]);
  gitIn(repoDir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repoDir, "seed.txt"), "seed\n");
  gitIn(repoDir, ["add", "seed.txt"]);
  const stamp = "1717200000 +0000"; // 2024-06-01, pinned: no wall-clock dependency
  gitIn(repoDir, ["commit", "-q", "-m", "Initial commit"], {
    GIT_AUTHOR_NAME: FIXTURE_AUTHOR.name,
    GIT_AUTHOR_EMAIL: FIXTURE_AUTHOR.email,
    GIT_AUTHOR_DATE: stamp,
    GIT_COMMITTER_NAME: FIXTURE_AUTHOR.name,
    GIT_COMMITTER_EMAIL: FIXTURE_AUTHOR.email,
    GIT_COMMITTER_DATE: stamp,
  });
  return gitIn(repoDir, ["rev-parse", "HEAD"]).trim();
}

// A synthetic commit record in the exact shape _parseMetadataLine
// (git-log-local.js:1500-1526) produces, for driving the _gitLogForRepo seam.
function syntheticInitialCommit(hash) {
  return {
    hash,
    author_ts: "2024-06-01T00:00:00+00:00",
    author_name: FIXTURE_AUTHOR.name,
    author_email: FIXTURE_AUTHOR.email,
    subject: "Initial commit",
    parents: [],
    file_changes: [],
    file_changes_truncated: false,
    body: "",
    body_truncated: false,
  };
}

function onlyRepoCursor(state) {
  const map = state && state.per_repo_cursors;
  assert.ok(map && typeof map === "object", "per_repo_cursors missing from persisted state");
  const keys = Object.keys(map);
  assert.equal(keys.length, 1, `expected exactly one repo cursor, got ${JSON.stringify(map)}`);
  return map[keys[0]];
}

// =============================================================================
// T8/T9 CLASS GUARD — the classifier, factored out as a pure function so T9 can
// exercise it on synthetic strings with no disk involved.
// =============================================================================

// SAFE RULE — deliberately STRICTER than "the RHS contains a `?`".
//
// The naive `?`-means-SAFE rule has a measured hole: screentime.js's zero-row
// branch shipped, pre-fix, as
//     last_cursor_advance_ts: typeof opts.now === "string" ? opts.now : serverTs(),
// which is a ternary between two now()-flavoured values and is a live instance
// of exactly the defect class this guard exists to catch. Under the naive rule
// the guard would score it SAFE and go green on the bug. So a site is SAFE only
// when its RHS is a conditional AND references a CARRIED-FORWARD value — the
// `carriedAdvanceTs` local from telegram.js:256-257, or a direct read-back of
// the prior `.last_cursor_advance_ts`. T9 pins both directions; do not
// "simplify" this back to a bare `?` test.
const SAFE_RHS = (rhs) =>
  /\?/.test(rhs) && /\bcarriedAdvanceTs\b|\.last_cursor_advance_ts\b/.test(rhs);

// index.js is excluded from the on-disk scan: it is ConnectorBase + the
// staleness CLASSIFIER, not a connector. Its four `last_cursor_advance_ts:`
// writes (:594, :621, :696, :717) construct the health-report envelopes
// returned by _healthFromState / metadataFromState — they echo a value already
// read from state, they never stamp a cursor — and the file is outside this
// node's edit remit, so the defect class cannot be reintroduced there.
const SCAN_EXCLUDE = new Set(["index.js"]);

// Sites that are ALREADY CORRECT because a real progress gate encloses them.
// Each entry cites the enclosing gate, verified against the tree.
const ALLOWLIST = new Map([
  ["github-events.js:1009", "enclosed by `if (highestId !== priorState.last_event_id || lruChanged)` at github-events.js:1000"],
  ["github-events.js:1022", "enclosed by `else if (priorState.username !== username)` at github-events.js:1013"],
  ["imessage.js:982", "enclosed by `if (latestRowid != null)` at imessage.js:976"],
  ["mail.js:618", "enclosed by `if (latestRowid != null)` at mail.js:612"],
  ["whatsapp.js:1299", "enclosed by `if (cursorAdvanced)` at whatsapp.js:1297"],
]);

// _extractRhs — take the right-hand side of an object-literal property, from
// the character after its colon to the enclosing depth-0 `,` / `;` / closing
// brace. Continuation lines are JOINED so a ternary split across lines is not
// truncated into a false UNSAFE. String literals and `//` tails are respected.
function _extractRhs(lines, startLine, startCol) {
  let depth = 0;
  let out = "";
  const lastLine = Math.min(lines.length - 1, startLine + 12);
  for (let li = startLine; li <= lastLine; li++) {
    const line = lines[li];
    let inStr = null;
    for (let ci = li === startLine ? startCol : 0; ci < line.length; ci++) {
      const ch = line[ci];
      if (inStr !== null) {
        if (ch === "\\") { out += ch + (line[ci + 1] || ""); ci += 1; continue; }
        if (ch === inStr) inStr = null;
        out += ch;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; out += ch; continue; }
      if (ch === "/" && line[ci + 1] === "/") break; // trailing line comment
      if (ch === "(" || ch === "[" || ch === "{") { depth += 1; out += ch; continue; }
      if (ch === ")" || ch === "]" || ch === "}") {
        if (depth === 0) return out.trim(); // closed the enclosing object literal
        depth -= 1;
        out += ch;
        continue;
      }
      if ((ch === "," || ch === ";") && depth === 0) return out.trim();
      out += ch;
    }
    out += "\n";
  }
  return out.trim();
}

// classifyStampSites — pure. Given a file's text, return every WRITE of
// `last_cursor_advance_ts` with its RHS and a SAFE/UNSAFE verdict.
//
// Not a hit:
//   - a line whose trimmed form starts with `//` or `*` (comment / JSDoc);
//   - a READ, i.e. an occurrence preceded by `.` — `state.last_cursor_advance_ts`
//     or `parsed?.last_cursor_advance_ts`. Note the read-back idiom
//     `typeof state.last_cursor_advance_ts === "string" ? state.last_cursor_advance_ts : null`
//     DOES contain `last_cursor_advance_ts :` (the ternary colon), so dropping
//     dotted occurrences is what keeps the naive `?` rule from scoring a read
//     as a SAFE write for entirely the wrong reason.
export function classifyStampSites(sourceText, fileLabel) {
  const lines = String(sourceText).split("\n");
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    const re = /\blast_cursor_advance_ts\s*:/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const before = line.slice(0, m.index).trimEnd();
      if (before.endsWith(".")) continue; // property read, not an object-literal key
      const colonCol = m.index + m[0].length - 1;
      const rhs = _extractRhs(lines, i, colonCol + 1);
      const key = `${fileLabel}:${i + 1}`;
      const allowed = ALLOWLIST.has(key);
      hits.push({
        key,
        file: fileLabel,
        line: i + 1,
        rhs,
        safe: SAFE_RHS(rhs) || allowed,
        reason: SAFE_RHS(rhs)
          ? "carried-forward conditional"
          : (allowed ? ALLOWLIST.get(key) : "unconditional now()-stamp"),
      });
    }
  }
  return hits;
}

function scanConnectorsDir() {
  const files = readdirSync(CONNECTORS_LIB_DIR)
    .filter((f) => f.endsWith(".js") && !SCAN_EXCLUDE.has(f))
    .sort();
  const all = [];
  for (const f of files) {
    const text = readFileSync(join(CONNECTORS_LIB_DIR, f), "utf8");
    all.push(...classifyStampSites(text, f));
  }
  return all;
}

// =============================================================================
// T1 — slack: failing-auth poll must NOT stamp an advance.
// =============================================================================
test("T1 slack: failing-auth poll carries last_cursor_advance_ts forward (live prod shape)", async () => {
  const { cursorPath, sourceLedgerPath } = caseDirs("slack-t1");
  // Every Slack API call answers ok:false/invalid_auth, so _slackApiCall throws
  // slack_auth_invalid_auth, resolveSelfUserId (slack.js:429-441) returns null,
  // and the workspace is skipped at slack.js:473-477 — workspaces stays {} and
  // NOTHING can have advanced.
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: new Map(),
    async json() { return { ok: false, error: "invalid_auth" }; },
  });
  const c = new SlackConnector({
    userToken: "xoxp-test",
    workspaceIds: ["T01"],
    fetchImpl,
    now: nowFn,
    cursorPath,
    sourceLedgerPath,
  });
  const seeded = {
    workspaces: {},
    last_polled_ts: SEEDED_TS,
    last_appended_ts: null,
    last_appended_id: null,
    last_cursor_advance_ts: SEEDED_TS,
    error_count: 0,
  };
  await c.writeCursor(seeded);

  const res = await c.pollOnce();
  assert.equal(res.appended, 0, "nothing may be appended on an invalid_auth poll");

  const after = await c.readCursor();
  assertDurableCursorInvariant(seeded, after, "T1 slack failing-auth");
  assert.equal(
    after.last_cursor_advance_ts,
    SEEDED_TS,
    "an auth-failed poll advanced nothing; the stamp must be carried forward, not restamped",
  );
  // Over-fix guard: last_polled_ts means "we ran" and stays unconditional
  // (telegram.js:253-254). If this moved to NOW_TS the poll really did execute.
  assert.equal(after.last_polled_ts, NOW_TS, "last_polled_ts must still move on a no-progress poll");
  assert.equal(after.last_appended_ts, null);
});

// =============================================================================
// T2 — slack: a REAL channel-cursor advance DOES stamp. (positive control)
// =============================================================================
test("T2 slack: a real channel-cursor advance stamps last_cursor_advance_ts", async () => {
  const { cursorPath, sourceLedgerPath } = caseDirs("slack-t2");
  const fetchImpl = async (url, opts) => {
    const method = String(url).split("/").pop();
    let body;
    if (method === "auth.test") {
      body = { ok: true, user_id: "U01" };
    } else if (method === "conversations.list") {
      body = {
        ok: true,
        channels: [{ id: "C01", is_channel: true, is_private: false }],
        response_metadata: { next_cursor: "" },
      };
    } else if (method === "conversations.history") {
      body = {
        ok: true,
        has_more: false,
        messages: [{
          ts: "1770000000.000100",
          user: "U01",
          text: "ALPHA shipped the connector staleness sensor fix this afternoon.",
        }],
        response_metadata: { next_cursor: "" },
      };
    } else {
      body = { ok: false, error: "unknown_method" };
    }
    return { ok: true, status: 200, headers: new Map(), async json() { return body; } };
  };
  const c = new SlackConnector({
    userToken: "xoxp-test",
    workspaceIds: ["T01"],
    fetchImpl,
    now: nowFn,
    cursorPath,
    sourceLedgerPath,
  });
  const seeded = {
    workspaces: {},
    last_polled_ts: SEEDED_TS,
    last_appended_ts: null,
    last_appended_id: null,
    last_cursor_advance_ts: SEEDED_TS,
    error_count: 0,
  };
  await c.writeCursor(seeded);

  await c.pollOnce();

  const after = await c.readCursor();
  assertDurableCursorInvariant(seeded, after, "T2 slack real advance");
  assert.notEqual(
    after.last_cursor_advance_ts,
    SEEDED_TS,
    "the channel cursor moved off null (slack.js:539-540, `if (newLastTs && newLastTs !== " +
      "cursor.last_ts) this.writeChannelCursor(...)`) — this IS an advance and must stamp",
  );
  assert.equal(after.last_cursor_advance_ts, NOW_TS);
});

// =============================================================================
// T3 — screentime: zero-row page must NOT stamp.
// =============================================================================
// ROUTE USED: the spec's stated acceptable alternative — the fixture DB is
// built from the existing test/fixtures/screentime-fixture.sql (the recipe at
// mcp/test/screentime-connector.test.mjs:112-121) and `last_z_pk` is seeded
// ABOVE every fixture row, so queryZobjectPage (screentime.js:919-981) selects
// `WHERE o.Z_PK > ?` and returns zero rows. That drives the rows.length === 0
// early-return branch without hand-synthesizing the CoreDuet schema.
const SCREENTIME_HIGH_WATERMARK = 999999;

function buildScreentimeDb(dbPath) {
  const sql = readFileSync(
    join(import.meta.dirname, "fixtures", "screentime-fixture.sql"),
    "utf8",
  );
  try { rmSync(dbPath); } catch { /* first build */ }
  const db = new DatabaseSync(dbPath);
  db.exec(sql);
  db.close();
}

test("T3 screentime: zero-row page carries last_cursor_advance_ts forward", async () => {
  const { cursorPath, sourceLedgerPath } = caseDirs("screentime-t3");
  const dbPath = join(TEST_ROOT, "knowledgeC-t3.db");
  buildScreentimeDb(dbPath);
  const c = new ScreenTimeConnector({
    knowledgeDbPath: dbPath,
    dndAssertionsPath: join(TEST_ROOT, "no-such-assertions.json"),
    cursorPath,
    sourceLedgerPath,
  });
  const seeded = {
    last_z_pk: SCREENTIME_HIGH_WATERMARK,
    last_appended_ts: null,
    last_appended_id: null,
    last_cursor_advance_ts: SEEDED_TS,
    error_count: 0,
  };
  await c.writeCursor(seeded);

  const res = await c.pollOnce({ now: NOW_TS });
  assert.equal(res.appended, 0, "cursor is past every fixture row; the page must be empty");

  const after = await c.readCursor();
  assertDurableCursorInvariant(seeded, after, "T3 screentime zero-row");
  assert.equal(
    after.last_cursor_advance_ts,
    SEEDED_TS,
    "rows.length === 0 can never represent an advance; the stamp must be carried forward",
  );
  assert.equal(after.last_z_pk, SCREENTIME_HIGH_WATERMARK, "last_z_pk must not move either");
});

// =============================================================================
// T4 — screentime: a page that advances last_z_pk DOES stamp. (positive control)
// =============================================================================
test("T4 screentime: advancing last_z_pk past a silently-skipped row stamps", async () => {
  const { cursorPath, sourceLedgerPath } = caseDirs("screentime-t4");
  const dbPath = join(TEST_ROOT, "knowledgeC-t4.db");
  buildScreentimeDb(dbPath);
  // One row ABOVE the seeded watermark, on an unrecognized stream. Advancing
  // past a silently-skipped row IS a genuine cursor advance — the rationale is
  // mcp/test/screentime-connector.test.mjs:346-349 (leaving highestPk behind
  // would force every poll to re-scan the same rows forever), and it mirrors
  // telegram's "append OR skip-past progress" (telegram.js:247).
  const newPk = SCREENTIME_HIGH_WATERMARK + 1;
  {
    const db = new DatabaseSync(dbPath);
    db.exec(
      `INSERT INTO ZOBJECT (Z_PK, ZSTREAMNAME, ZSTARTDATE, ZENDDATE, ZVALUESTRING, ZVALUEINTEGER, ZSTRUCTUREDMETADATA)
       VALUES (${newPk}, '/coreduet/clientstate', 770000000, 770000060, NULL, NULL, NULL);`,
    );
    db.close();
  }
  const c = new ScreenTimeConnector({
    knowledgeDbPath: dbPath,
    dndAssertionsPath: join(TEST_ROOT, "no-such-assertions.json"),
    cursorPath,
    sourceLedgerPath,
  });
  const seeded = {
    last_z_pk: SCREENTIME_HIGH_WATERMARK,
    last_appended_ts: null,
    last_appended_id: null,
    last_cursor_advance_ts: SEEDED_TS,
    error_count: 0,
  };
  await c.writeCursor(seeded);

  await c.pollOnce({ now: NOW_TS });

  const after = await c.readCursor();
  assertDurableCursorInvariant(seeded, after, "T4 screentime last_z_pk advance");
  assert.equal(after.last_z_pk, newPk, "the page must have advanced last_z_pk past the skipped row");
  assert.notEqual(after.last_cursor_advance_ts, SEEDED_TS, "skip-past progress IS an advance");
  assert.equal(after.last_cursor_advance_ts, NOW_TS);
});

// =============================================================================
// T5 — codex-cli: poll over an EMPTY sessions dir must NOT stamp.
// =============================================================================
test("T5 codex-cli: empty sessions dir carries last_cursor_advance_ts forward", async () => {
  const { cursorPath, sourceLedgerPath } = caseDirs("codex-t5");
  const emptyDir = join(TEST_ROOT, "empty-sessions");
  mkdirSync(emptyDir, { recursive: true });
  // The dir exists but holds no *.jsonl, so discoverSessionFiles()
  // (codex-cli.js:686-703) yields nothing: no per-session cursor and no
  // per-file offset can move.
  const c = new CodexCliConnector({
    sessionsGlobs: [join(emptyDir, "*.jsonl")],
    now: nowFn,
    cursorPath,
    sourceLedgerPath,
  });
  const seeded = {
    per_session_cursors: {},
    per_session_offsets: {},
    per_session_file_meta: {},
    last_polled_ts: SEEDED_TS,
    last_appended_ts: null,
    last_appended_id: null,
    last_cursor_advance_ts: SEEDED_TS,
    error_count: 0,
  };
  await c.writeCursor(seeded);

  const res = await c.pollOnce();
  assert.equal(res.appended, 0);
  assert.equal(res.sessions, 0, "no session files may have been discovered");

  const after = await c.readCursor();
  assertDurableCursorInvariant(seeded, after, "T5 codex-cli empty sessions dir");
  assert.equal(
    after.last_cursor_advance_ts,
    SEEDED_TS,
    "no session file existed; no cursor moved, so the stamp must be carried forward",
  );
  assert.equal(after.last_polled_ts, NOW_TS, "last_polled_ts still means 'we ran'");
});

// =============================================================================
// T6 — codex-cli: one rollout with one ingestible turn DOES stamp. (control)
// =============================================================================
test("T6 codex-cli: one ingestible turn stamps last_cursor_advance_ts", async () => {
  const { cursorPath, sourceLedgerPath } = caseDirs("codex-t6");
  // Fixture-writing style mirrors mcp/test/codex-cli-connector.test.mjs:606-630
  // (read, not imported — that file is a script, not a module).
  const sessionDir = join(TEST_ROOT, "codex-t6-sessions");
  mkdirSync(sessionDir, { recursive: true });
  const sessionId = "00000000-0000-7000-8000-000000000008";
  const sessionFile = join(sessionDir, `rollout-2026-07-03T00-00-00-${sessionId}.jsonl`);
  const meta = JSON.stringify({
    timestamp: "2026-07-03T00:00:00.000Z",
    type: "session_meta",
    payload: { id: sessionId, cwd: "/tmp/cursor-stamp-cwd" },
  });
  const row = (role, text) =>
    JSON.stringify({
      timestamp: "2026-07-03T00:00:01.000Z",
      type: "response_item",
      payload: { type: "message", role, content: [{ type: "input_text", text }] },
    });
  writeFileSync(
    sessionFile,
    [
      meta,
      row("user", "first question about the connector staleness sensor"),
      row("assistant", "A thorough first answer about how the staleness sensor is read."),
    ].join("\n") + "\n",
  );

  const c = new CodexCliConnector({
    sessionsGlobs: [join(sessionDir, "rollout-*.jsonl")],
    now: nowFn,
    cursorPath,
    sourceLedgerPath,
  });
  const seeded = {
    per_session_cursors: {},
    per_session_offsets: {},
    per_session_file_meta: {},
    last_polled_ts: SEEDED_TS,
    last_appended_ts: null,
    last_appended_id: null,
    last_cursor_advance_ts: SEEDED_TS,
    error_count: 0,
  };
  await c.writeCursor(seeded);

  const res = await c.pollOnce();
  assert.equal(res.appended, 1, `expected exactly one appended turn, got ${JSON.stringify(res)}`);

  const after = await c.readCursor();
  assertDurableCursorInvariant(seeded, after, "T6 codex-cli ingestible turn");
  assert.notEqual(after.last_cursor_advance_ts, SEEDED_TS, "a real turn ingest IS an advance");
  assert.equal(after.last_cursor_advance_ts, NOW_TS);
});

// =============================================================================
// T7 — git-log-local: a root with no git repos must NOT stamp.
// =============================================================================
test("T7 git-log-local: no-repos root carries last_cursor_advance_ts forward", async () => {
  const { cursorPath, sourceLedgerPath } = caseDirs("git-log-t7");
  const noRepos = join(TEST_ROOT, "no-repos");
  mkdirSync(noRepos, { recursive: true });
  // discoverRepos() (git-log-local.js:1181-1187) returns [] — the walk finds
  // no `.git`, so no per-repo cursor can move.
  const c = new GitLogConnector({
    repoRoots: [noRepos],
    now: nowFn,
    cursorPath,
    sourceLedgerPath,
  });
  const seeded = {
    per_repo_cursors: {},
    last_polled_ts: SEEDED_TS,
    last_appended_ts: null,
    last_appended_id: null,
    last_cursor_advance_ts: SEEDED_TS,
    error_count: 0,
  };
  await c.writeCursor(seeded);

  const res = await c.pollOnce();
  assert.equal(res.repos, 0, "no repos may have been discovered");
  assert.equal(res.appended, 0);

  const after = await c.readCursor();
  assertDurableCursorInvariant(seeded, after, "T7 git-log no-repos root");
  assert.equal(
    after.last_cursor_advance_ts,
    SEEDED_TS,
    "no repo, no commit, no cursor movement — the stamp must be carried forward",
  );
  assert.equal(after.last_polled_ts, NOW_TS, "last_polled_ts must still move on a no-progress poll");
});

// =============================================================================
// T8 — CLASS GUARD: static scan; a reintroduction anywhere must FLAG.
// =============================================================================
test("T8 class guard: no UNSAFE last_cursor_advance_ts write site on disk", () => {
  const hits = scanConnectorsDir();
  const unsafe = hits.filter((h) => !h.safe);
  assert.deepEqual(
    unsafe.map((h) => `${h.key}  RHS=${JSON.stringify(h.rhs)}`),
    [],
    "every last_cursor_advance_ts write must either be a carried-forward conditional " +
      "or be ALLOWLISTed with its enclosing progress gate cited",
  );
});

// =============================================================================
// T9 — GUARD ANTI-VACUITY: both error directions.
// =============================================================================
test("T9 guard anti-vacuity: classifier verdicts on synthetic strings", () => {
  const verdict = (line) => classifyStampSites(line, "synthetic.js");

  // (a) the bare now()-stamp — the shape at slack/codex-cli/git-log pre-fix.
  const a = verdict("      last_cursor_advance_ts: nowTs,");
  assert.equal(a.length, 1, "a bare now()-stamp must register as exactly one hit");
  assert.equal(a[0].safe, false, "`: nowTs,` must be UNSAFE");

  // (b) the telegram triple — the fixed shape.
  const b = verdict("      last_cursor_advance_ts: cursorAdvanced ? nowTs : carriedAdvanceTs,");
  assert.equal(b.length, 1);
  assert.equal(b[0].safe, true, "the telegram carried-forward ternary must be SAFE");

  // (c) THE CASE THE NAIVE `?` RULE GETS WRONG. This exact string is what
  // `git show HEAD:mcp/lib/connectors/screentime.js | sed -n 1034p` prints,
  // i.e. the pre-fix zero-row branch — a ternary between two now()-flavoured values,
  // i.e. a live instance of the defect class. A `?`-means-SAFE guard scores it
  // SAFE and goes green on the bug; this assertion is what makes the guard real.
  const c = verdict('      last_cursor_advance_ts: typeof opts.now === "string" ? opts.now : serverTs(),');
  assert.equal(c.length, 1);
  assert.equal(c[0].safe, false, "a now()-vs-now() ternary must be UNSAFE, not SAFE");

  // (d) a comment mentioning the field is not a hit at all.
  const d = verdict("    // last_cursor_advance_ts is stamped with now()");
  assert.equal(d.length, 0, "comment lines must not register as write sites");

  // (e) the carried-forward READ-BACK is not a hit either — it contains
  // `last_cursor_advance_ts :` via the ternary colon, so a classifier that did
  // not drop dotted occurrences would call it SAFE for entirely the wrong reason.
  const e = verdict(
    '    const a = typeof state.last_cursor_advance_ts === "string" ? state.last_cursor_advance_ts : null;',
  );
  assert.equal(e.length, 0, "a property read must not register as a write site");

  // (f) NON-VACUITY: a regex that silently matches nothing would make T8 pass
  // for free. Measured on this tree: 11 write sites across
  // mcp/lib/connectors/*.js (index.js excluded, see SCAN_EXCLUDE). `>= 9`
  // leaves headroom for sibling nodes' churn.
  const onDisk = scanConnectorsDir();
  assert.ok(
    onDisk.length >= 9,
    `expected >= 9 on-disk write sites, found ${onDisk.length} — the scan regex is broken ` +
      `and T8 would pass vacuously. Hits: ${onDisk.map((h) => h.key).join(", ")}`,
  );

  // (g) the ALLOWLIST must be exactly the five already-gated sites, and every
  // one of them must still be a real hit at the cited line.
  assert.equal(ALLOWLIST.size, 5);
  const keys = new Set(onDisk.map((h) => h.key));
  for (const k of ALLOWLIST.keys()) {
    assert.ok(keys.has(k), `ALLOWLIST entry ${k} no longer matches a write site — re-verify its gate`);
  }
});

// =============================================================================
// T10 — git-log-local: QUARANTINE ADVANCE writes a durable cursor, so it MUST
// stamp. This is the wave-1 refutation reproduced as a test.
//
// git-log-local.js advances `perRepoCursors` from THREE call sites, all of them
// persisted as `per_repo_cursors` (git-log-local.js:2072) and therefore durable.
// Post-fix all three route through noteRepoCursor (declared :1669, its single
// raw assignment :1674):
//     :1800  tick-dedup skip-past   (F-NEW-W7-GIT-LOG-COMMIT-HASH-DEDUP)
//     :1848  quarantine advance
//     :2026  append / dedup advance
// Pre-fix those were three bare `perRepoCursors[repoPath] = commit.hash;`
// assignments (HEAD:1755 / :1800 / :1976) and wave 1 gated only the last one. A
// repo whose ONLY commit is an initial-commit variant never reaches the append
// path at all — it exits at the quarantine advance — so per_repo_cursors went
// {} -> <HEAD sha> while last_cursor_advance_ts stayed frozen at the seeded
// literal. That is exactly the defect this node exists to close, and it was
// still live on two of the three paths.
// =============================================================================
test("T10 git-log-local: quarantine advance writes a durable cursor and MUST stamp", async () => {
  const { cursorPath, sourceLedgerPath } = caseDirs("git-log-t10");
  const repoDir = join(TEST_ROOT, "repo-t10");
  const headSha = initialCommitOnlyRepo(repoDir);

  const c = new GitLogConnector({
    repoRoots: [repoDir],
    walkDepth: 0,
    now: nowFn,
    cursorPath,
    sourceLedgerPath,
  });
  const seeded = {
    per_repo_cursors: {},
    last_polled_ts: SEEDED_TS,
    last_appended_ts: null,
    last_appended_id: null,
    last_cursor_advance_ts: SEEDED_TS,
    error_count: 0,
  };
  await c.writeCursor(seeded);

  const res = await c.pollOnce();
  assert.equal(res.repos, 1, `the fixture repo must be discovered: ${JSON.stringify(res)}`);
  assert.equal(res.appended, 0, "an initial-commit variant is quarantined, never appended");

  const after = await c.readCursor();
  // (a) durable progress really happened — the quarantine branch persisted the
  //     real HEAD sha into per_repo_cursors.
  assert.equal(
    onlyRepoCursor(after),
    headSha,
    "the quarantine branch (git-log-local.js:1848) must have persisted the HEAD sha",
  );
  // (b) …therefore the stamp must have moved. THIS is the assertion that fails
  //     against wave-1 source.
  assert.equal(
    after.last_cursor_advance_ts,
    NOW_TS,
    "per_repo_cursors advanced {} -> HEAD but the advance stamp did not move — " +
      "the quarantine-advance site (git-log-local.js:1848) mutates the durable cursor " +
      "without setting cursorAdvanced",
  );
  assert.equal(after.last_polled_ts, NOW_TS, "last_polled_ts stays unconditional");
  assertDurableCursorInvariant(seeded, after, "T10 git-log quarantine advance");
});

// =============================================================================
// T11 — git-log-local: TICK-DEDUP SKIP-PAST (:1796-1802) also writes a durable
// cursor.
//
// REACHABILITY. `git log --all --reflog` dedups within a single traversal, so a
// plain on-disk fixture cannot emit the same commit twice in one tick and the
// branch is unreachable from a repo alone. It IS reachable in production (the
// F-NEW-W7 comment at :1679-1699 documents the re-walk that motivated the tick
// Set), so the test drives it through the existing instance seam
// `_gitLogForRepo` — the same seam the connector already exposes for injection —
// returning [A, B, A] where all three are initial-commit variants:
//     A  -> not in the tick Set -> quarantined, tick Set gains A, cursor := A
//     B  -> not in the tick Set -> quarantined, tick Set gains B, cursor := B
//     A  -> ALREADY in the tick Set -> :1796 skip-past,          cursor := A
// The persisted cursor ending on A (not B) is the proof that control reached
// the skip-past branch and that ITS write (:1800) is the durable one.
// =============================================================================
test("T11 git-log-local: within-tick dedup skip-past is a durable cursor write and MUST stamp", async () => {
  const { cursorPath, sourceLedgerPath } = caseDirs("git-log-t11");
  const repoDir = join(TEST_ROOT, "repo-t11");
  initialCommitOnlyRepo(repoDir); // real repo so discovery + classification run

  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);
  const c = new GitLogConnector({
    repoRoots: [repoDir],
    walkDepth: 0,
    now: nowFn,
    cursorPath,
    sourceLedgerPath,
  });
  // Instance seam. Returns the same commit object twice with a different one in
  // between, which is what a re-walk looks like from pollOnce's point of view.
  c._gitLogForRepo = () => [
    syntheticInitialCommit(shaA),
    syntheticInitialCommit(shaB),
    syntheticInitialCommit(shaA),
  ];

  const seeded = {
    per_repo_cursors: {},
    last_polled_ts: SEEDED_TS,
    last_appended_ts: null,
    last_appended_id: null,
    last_cursor_advance_ts: SEEDED_TS,
    error_count: 0,
  };
  await c.writeCursor(seeded);

  const res = await c.pollOnce();
  assert.equal(res.repos, 1);
  assert.equal(res.appended, 0, "initial-commit variants are quarantined, never appended");

  const after = await c.readCursor();
  assert.equal(
    onlyRepoCursor(after),
    shaA,
    "the persisted cursor must be A, not B — that is what proves control reached the " +
      "already-quarantined-this-tick branch at git-log-local.js:1796 and that its write " +
      "(:1800) won",
  );
  assert.equal(
    after.last_cursor_advance_ts,
    NOW_TS,
    "the tick-dedup skip-past durably moved per_repo_cursors; the stamp must move with it",
  );
  assertDurableCursorInvariant(seeded, after, "T11 git-log tick-dedup skip-past");
});

// =============================================================================
// T12 — git-log-local: IDEMPOTENCY. The anti-over-fix control.
//
// A cursor advance means a VALUE CHANGE, not an assignment. Two beats:
//   (a) a natural second poll with no new commits (the incremental
//       `<sha>..HEAD` walk returns nothing) must not stamp;
//   (b) a re-walk that re-emits the SAME commit — so :1848 re-assigns the hash
//       already stored — must not stamp either. Beat (b) is what a plain
//       `cursorAdvanced = true` next to every assignment would get wrong, which
//       is why the fix compares against the prior own-value first.
// =============================================================================
test("T12 git-log-local: re-assigning an unchanged cursor value is not an advance", async () => {
  const { cursorPath, sourceLedgerPath } = caseDirs("git-log-t12");
  const repoDir = join(TEST_ROOT, "repo-t12");
  const headSha = initialCommitOnlyRepo(repoDir);

  const mkConnector = () =>
    new GitLogConnector({
      repoRoots: [repoDir],
      walkDepth: 0,
      now: nowFn,
      cursorPath,
      sourceLedgerPath,
    });

  // Beat 0 — the first poll, which legitimately advances (same shape as T10).
  const c1 = mkConnector();
  await c1.writeCursor({
    per_repo_cursors: {},
    last_polled_ts: SEEDED_TS,
    last_appended_ts: null,
    last_appended_id: null,
    last_cursor_advance_ts: SEEDED_TS,
    error_count: 0,
  });
  await c1.pollOnce();
  const afterFirst = await c1.readCursor();
  assert.equal(onlyRepoCursor(afterFirst), headSha);
  assert.equal(afterFirst.last_cursor_advance_ts, NOW_TS, "first poll advanced");

  // Beat (a) — re-seed ONLY the stamp, then poll again with nothing new.
  const seededA = { ...afterFirst, last_cursor_advance_ts: SEEDED_TS };
  const c2 = mkConnector();
  await c2.writeCursor(seededA);
  await c2.pollOnce();
  const afterA = await c2.readCursor();
  assert.equal(
    onlyRepoCursor(afterA),
    headSha,
    "no new commits: the persisted cursor must be unchanged",
  );
  assert.equal(
    afterA.last_cursor_advance_ts,
    SEEDED_TS,
    "nothing moved; the stamp must be carried forward, not restamped",
  );
  assert.equal(afterA.last_polled_ts, NOW_TS, "last_polled_ts still means 'we ran'");
  assertDurableCursorInvariant(seededA, afterA, "T12a git-log idle re-poll");

  // Beat (b) — force a re-walk of the SAME commit through the seam, so the
  // quarantine branch re-assigns the hash that is already stored.
  const seededB = { ...afterA, last_cursor_advance_ts: SEEDED_TS };
  const c3 = mkConnector();
  c3._gitLogForRepo = () => [syntheticInitialCommit(headSha)];
  await c3.writeCursor(seededB);
  await c3.pollOnce();
  const afterB = await c3.readCursor();
  assert.equal(onlyRepoCursor(afterB), headSha, "the re-walk stored the same hash");
  assert.equal(
    afterB.last_cursor_advance_ts,
    SEEDED_TS,
    "re-assigning the identical hash is NOT progress — the gate must be change-detecting, " +
      "not merely assignment-detecting",
  );
  assertDurableCursorInvariant(seededB, afterB, "T12b git-log same-hash re-walk");
});

// =============================================================================
// T13 — MUTATION-SITE PARITY GUARD (static).
//
// T8 checks the STAMP. This checks the FLAG that feeds it. Wave 1 shipped a
// correct stamp expression fed by a flag that only one of three mutation sites
// could set, and no static check noticed. For each connector that carries a
// cursor map, count the sites that mutate it and require at least as many
// `cursorAdvanced = true` sets — one per raw mutation, or one inside the single
// shared helper that every mutation routes through.
// =============================================================================
const FLAG_SET_RE = /\bcursorAdvanced\s*=\s*true\b/;

const MUTATION_SITE_GUARD = [
  {
    file: "git-log-local.js",
    what: "perRepoCursors[<repo>] = <hash>",
    // Post-fix this collapses to ONE raw site (the body of noteRepoCursor);
    // the three call sites route through it. Pre-fix it was three raw sites
    // against a single flag set — the wave-1 defect, which this catches.
    mutation: /\bperRepoCursors\s*\[[^\]]+\]\s*=(?!=)/,
  },
  {
    file: "codex-cli.js",
    what: "perSessionCursors[<id>] / perSessionOffsets[<file>] = ...",
    mutation: /\b(?:perSessionCursors|perSessionOffsets)\s*\[[^\]]+\]\s*=(?!=)/,
  },
  {
    file: "slack.js",
    what: "this.writeChannelCursor(...)",
    // `this.` is load-bearing: the bare name also matches the METHOD
    // DEFINITION at slack.js:235, which is not a mutation site.
    mutation: /\bthis\.writeChannelCursor\s*\(/,
  },
];

function matchingLines(text, re) {
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    if (re.test(lines[i])) out.push(i + 1);
  }
  return out;
}

test("T13 mutation-site parity: every cursor-map mutation is covered by a cursorAdvanced set", () => {
  for (const entry of MUTATION_SITE_GUARD) {
    const text = readFileSync(join(CONNECTORS_LIB_DIR, entry.file), "utf8");
    const mutations = matchingLines(text, entry.mutation);
    const flagSets = matchingLines(text, FLAG_SET_RE);

    // Non-vacuity, same discipline as T9(f): a regex that matched nothing would
    // make the parity check pass for free.
    assert.ok(
      mutations.length > 0,
      `${entry.file}: found ZERO \`${entry.what}\` sites — the mutation regex is broken and ` +
        "this guard would pass vacuously",
    );
    assert.ok(
      flagSets.length > 0,
      `${entry.file}: found ZERO \`cursorAdvanced = true\` sets — the advance flag is dead`,
    );
    assert.ok(
      flagSets.length >= mutations.length,
      `${entry.file}: ${mutations.length} cursor-map mutation site(s) at line(s) ` +
        `${mutations.join(", ")} but only ${flagSets.length} \`cursorAdvanced = true\` ` +
        `set(s) at line(s) ${flagSets.join(", ")}. Every \`${entry.what}\` is DURABLE — it is ` +
        "persisted into connectors/<source>/state.json — so an ungated one advances the " +
        "cursor while last_cursor_advance_ts goes stale, which is precisely the defect this " +
        "suite gates. Gate the new mutation: route it through the file's shared advance " +
        "helper, or set cursorAdvanced on a real value change beside it.",
    );
  }
});

// =============================================================================
// T13b — git-log-local specifically: all three durable writes route through ONE
// shared helper, so the parity count above cannot be gamed by leaving a raw
// mutation next to an unrelated flag set.
// =============================================================================
test("T13b git-log-local: every perRepoCursors write routes through noteRepoCursor", () => {
  const text = readFileSync(join(CONNECTORS_LIB_DIR, "git-log-local.js"), "utf8");
  const rawMutations = matchingLines(text, /\bperRepoCursors\s*\[[^\]]+\]\s*=(?!=)/);
  assert.equal(
    rawMutations.length,
    1,
    `expected exactly ONE raw perRepoCursors assignment (inside noteRepoCursor); found ` +
      `${rawMutations.length} at line(s) ${rawMutations.join(", ")}. Every durable cursor ` +
      "write must go through the helper so the change-detection cannot be forgotten.",
  );

  const declLines = matchingLines(text, /\bconst\s+noteRepoCursor\s*=/);
  assert.equal(declLines.length, 1, "noteRepoCursor must be declared exactly once");
  const declLine = declLines[0];
  assert.ok(
    rawMutations[0] > declLine && rawMutations[0] <= declLine + 10,
    `the single raw perRepoCursors assignment (line ${rawMutations[0]}) must live inside the ` +
      `noteRepoCursor body declared at line ${declLine}`,
  );

  const callLines = matchingLines(text, /\bnoteRepoCursor\s*\(/).filter((l) => l !== declLine);
  assert.ok(
    callLines.length >= 3,
    `expected >= 3 noteRepoCursor call sites (tick-dedup skip-past, quarantine advance, ` +
      `append/dedup); found ${callLines.length} at line(s) ${callLines.join(", ")}`,
  );

  // The helper must be CHANGE-detecting, and proto-safe (commit b97565c closed
  // two prototype-key defects: a bare `perRepoCursors[repoPath]` returns
  // Function.prototype.toString for a repo literally named "toString").
  const body = text.split("\n").slice(declLine - 1, declLine + 10).join("\n");
  assert.match(
    body,
    /Object\.prototype\.hasOwnProperty\.call\s*\(\s*perRepoCursors\s*,/,
    "noteRepoCursor must read the prior value with a proto-safe own-property check",
  );
  assert.match(
    body,
    /cursorAdvanced\s*=\s*true/,
    "noteRepoCursor must set cursorAdvanced",
  );
});

// =============================================================================
// T13c — git-log-local: the D1 tip frontier (per_repo_ref_tips, durable in
// state.heavy.json) is mutated at exactly ONE site, inside noteRepoTips, which
// is change-detecting under stable JSON (a quiet poll re-storing the identical
// sorted list is not progress; a first `[]` is) and proto-safe. D3 added the
// bounded-first-run deferral (`[]` instead of the pre-walk snapshot) at the
// CALL site, not as a second raw write — this guard pins that shape. D5's
// ENOBUFS branch persists the PRE-WALK snapshot through the SAME single call
// (never a second write, never `[]` on that path) and adds no heavy-state
// key — pinned below too.
// =============================================================================
test("T13c git-log-local: every perRepoTips write routes through noteRepoTips", () => {
  const text = readFileSync(join(CONNECTORS_LIB_DIR, "git-log-local.js"), "utf8");
  const rawMutations = matchingLines(text, /\bperRepoTips\s*\[[^\]]+\]\s*=(?!=)/);
  assert.equal(
    rawMutations.length,
    1,
    `expected exactly ONE raw perRepoTips assignment (inside noteRepoTips); found ` +
      `${rawMutations.length} at line(s) ${rawMutations.join(", ")}. per_repo_ref_tips is ` +
      "DURABLE (state.heavy.json), so every write must go through the helper or the " +
      "change-detection that keeps last_cursor_advance_ts honest can be forgotten.",
  );

  const declLines = matchingLines(text, /\bconst\s+noteRepoTips\s*=/);
  assert.equal(declLines.length, 1, "noteRepoTips must be declared exactly once");
  const declLine = declLines[0];
  assert.ok(
    rawMutations[0] > declLine && rawMutations[0] <= declLine + 10,
    `the single raw perRepoTips assignment (line ${rawMutations[0]}) must live inside the ` +
      `noteRepoTips body declared at line ${declLine}`,
  );

  const callLines = matchingLines(text, /\bnoteRepoTips\s*\(/).filter((l) => l !== declLine);
  assert.ok(
    callLines.length >= 1,
    `expected >= 1 noteRepoTips call site (the post-walk persist in pollOnce); found ` +
      `${callLines.length} at line(s) ${callLines.join(", ")}`,
  );

  const body = text.split("\n").slice(declLine - 1, declLine + 10).join("\n");
  assert.match(
    body,
    /Object\.prototype\.hasOwnProperty\.call\s*\(\s*perRepoTips\s*,/,
    "noteRepoTips must read the prior value with a proto-safe own-property check",
  );
  assert.match(
    body,
    /cursorAdvanced\s*=\s*true/,
    "noteRepoTips must set cursorAdvanced",
  );
  assert.match(
    body,
    /JSON\.stringify\(prior\)\s*!==\s*JSON\.stringify\(tips\)/,
    "noteRepoTips must change-detect under stable JSON (re-storing an identical list is not an advance)",
  );

  // D5: the ENOBUFS branch exists (marker set in _gitLogForRepo, counted in
  // pollOnce) and its persist is the ONE existing noteRepoTips call, whose
  // argument is the pre-walk snapshot unless the D3 deferral applies — no
  // ENOBUFS-specific write site, no `[]` on that path.
  assert.match(
    text,
    /walkInfo\.enobufs\s*=\s*\{\s*mode,\s*bytes:/,
    "D5: _gitLogForRepo must mark walkInfo.enobufs on an ENOBUFS listing",
  );
  assert.match(
    text,
    /if\s*\(walkInfo\.enobufs\)\s*\{\s*errorCount\s*\+=\s*1;\s*await\s+this\.tagError\("git_log_enobufs"\);/,
    "D5: pollOnce must count and tag an ENOBUFS walk (loud, never a green errors:0)",
  );
  assert.equal(
    callLines.length,
    1,
    `D5: the tips persist must stay ONE noteRepoTips call site; found ${callLines.length} at line(s) ${callLines.join(", ")}`,
  );
  const persistLine = text.split("\n")[callLines[0] - 1];
  assert.match(
    persistLine,
    /noteRepoTips\(repoPath,\s*firstRunHitBound\s*\?\s*\[\]\s*:\s*tipsBeforeWalk\)/,
    "D5: the single persist passes the PRE-WALK snapshot (tipsBeforeWalk) unless the D3 deferral applies — an ENOBUFS surface gets its real pre-walk frontier, never `[]`",
  );

  // D5: no new heavy-state key — the sidecar carries exactly the D1 field and
  // the durable-cursor field list this suite pins is unchanged.
  assert.match(
    text,
    /get heavyCursorKeys\(\)\s*\{\s*return \["per_repo_ref_tips"\];\s*\}/,
    "D5: heavyCursorKeys must remain exactly [\"per_repo_ref_tips\"] (no ENOBUFS marker key in state)",
  );
  assert.deepEqual(
    DURABLE_CURSOR_FIELDS,
    ["per_repo_cursors", "per_repo_ref_tips", "workspaces", "last_z_pk", "per_session_cursors", "per_session_offsets"],
    "D5: DURABLE_CURSOR_FIELDS gained or lost a key — the ENOBUFS decision is carried by tips + stderr + error_count, not by state shape",
  );
});

// =============================================================================
// Z — production-safety: ledgers/memory.jsonl must not have been touched.
// (mcp/test/slack-connector.test.mjs:442-452)
// =============================================================================
test("Z production ledger untouched by this suite", () => {
  if (prodBefore == null) return; // no production tree on this machine
  const st = statSync(PROD_LEDGER);
  assert.deepEqual(
    { mtimeMs: st.mtimeMs, size: st.size },
    prodBefore,
    "production ledgers/memory.jsonl drifted during the run — hermeticity breach OR the " +
      "watermark daemon appended concurrently; investigate before trusting this run",
  );
});
