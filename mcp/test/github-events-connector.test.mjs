// github-events-connector.test.mjs — Phase 2b github-events connector tests.
//
// Exercises lib/connectors/github-events.js:
//   T1 — 5 events on operator's own repos -> 5 ledger rows, all
//        consent_basis="first_party".
//   T2 — 3 events on others' repos with operator as actor -> 3 rows,
//        consent_basis="third_party_inferred".
//   T3 — cursor restart: runOnce twice; second call appends 0 events.
//   T4 — gh CLI missing / auth failure -> graceful: status="failed",
//        appended=0, no rows written.
//
// HERMETICITY: per the standing C-NEW-2 discipline, all env vars are set
// BEFORE the dynamic imports. Every disk write lands inside mkdtempSync;
// the live install is untouched. Post-exit cleanup
// rmSync's the tmpdir. The gh shell-out is replaced by an injected
// opts._ghExec stub; we never actually spawn `gh`.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { skipIfDaemonActive } from "./_hermetic-daemon-skip.mjs";
skipIfDaemonActive("github-events-connector");

// ---------------------------------------------------------------------------
// Hermetic root — MUST happen before any dynamic import.
// ---------------------------------------------------------------------------
const TEST_ROOT = mkdtempSync(join(tmpdir(), "github-events-connector-test-"));
mkdirSync(join(TEST_ROOT, "policy"), { recursive: true });
mkdirSync(join(TEST_ROOT, "ledgers"), { recursive: true });
mkdirSync(join(TEST_ROOT, "storage", "sources"), { recursive: true });
mkdirSync(join(TEST_ROOT, "connectors"), { recursive: true });
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
process.env.CONNECTORS_BASE_DIR = join(TEST_ROOT, "connectors");
process.on("exit", () => {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
});

// Production-safety pre-snapshot.
const PROD_LEDGER = join(homedir(), "memory-system", "ledgers", "memory.jsonl");
let prodBefore = null;
try { const st = statSync(PROD_LEDGER); prodBefore = { mtimeMs: st.mtimeMs, size: st.size }; } catch {}
const PROD_GH_LEDGER = join(homedir(), "memory-system", "storage", "sources", "github-events.jsonl");
let prodGhBefore = null;
try { const st = statSync(PROD_GH_LEDGER); prodGhBefore = { mtimeMs: st.mtimeMs, size: st.size }; } catch {}

// ---------------------------------------------------------------------------
// Dynamic imports.
// ---------------------------------------------------------------------------
const { GitHubEventsConnector } = await import("../lib/connectors/github-events.js");
const { connectorStatePath, STORAGE_DIR } = await import("../lib/config.js");

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

const SOURCE = "github-events";
const LEDGER_PATH = join(STORAGE_DIR, "sources", `${SOURCE}.jsonl`);

const FIXTURES = JSON.parse(
  readFileSync(new URL("./fixtures/gh-events-fixture.json", import.meta.url), "utf8"),
);
// The operator login is the fixture's dominant actor.login. It is derived from
// the fixture rather than repeated here, so the fixture stays the single source
// of the value and the owner partition below keeps holding if it is renamed.
const LOGIN_COUNTS = new Map();
for (const e of FIXTURES) {
  LOGIN_COUNTS.set(e.actor.login, (LOGIN_COUNTS.get(e.actor.login) || 0) + 1);
}
const [USERNAME, USERNAME_COUNT] = [...LOGIN_COUNTS].sort((a, b) => b[1] - a[1])[0];
if (!(USERNAME_COUNT * 2 > FIXTURES.length)) {
  throw new Error("gh-events fixture: no actor.login covers a majority of the events");
}

// Read all rows from the ledger.
function readRows() {
  if (!existsSync(LEDGER_PATH)) return [];
  const raw = readFileSync(LEDGER_PATH, "utf8").trim();
  if (raw === "") return [];
  return raw.split("\n").map((l) => JSON.parse(l));
}

function rmLedger() {
  try { rmSync(LEDGER_PATH); } catch {}
  try { rmSync(connectorStatePath(SOURCE)); } catch {}
}

// Fixtures partitioned by repo owner.
const FIRST_PARTY_EVENTS = FIXTURES.filter((e) => e.repo.name.startsWith(`${USERNAME}/`));
const THIRD_PARTY_EVENTS = FIXTURES.filter((e) => !e.repo.name.startsWith(`${USERNAME}/`));
if (FIRST_PARTY_EVENTS.length === 0 || THIRD_PARTY_EVENTS.length === 0) {
  throw new Error("gh-events fixture: need events on both operator-owned and other-owned repos");
}

// ===========================================================================
// T1 — 5 events on operator's own repos -> consent_basis=first_party
// ===========================================================================
console.log("\n--- T1: first-party classifier ---");
{
  rmLedger();
  const connector = new GitHubEventsConnector({ username: USERNAME });
  const res = await connector.pollOnce({
    _whoami: USERNAME,
    _fixtureEvents: FIRST_PARTY_EVENTS,
    now: () => new Date("2026-06-02T00:00:00.000Z"),
  });
  check("T1.a five first-party events appended", res.appended === FIRST_PARTY_EVENTS.length, JSON.stringify(res));
  check("T1.b zero errors", res.errors === 0);
  const rows = readRows();
  check("T1.c ledger has 5 rows", rows.length === FIRST_PARTY_EVENTS.length, `got ${rows.length}`);
  const allFirstParty = rows.every((r) => r.source_policy?.consent_basis === "first_party");
  check("T1.d every row classified first_party", allFirstParty);
  const allFullExcise = rows.every((r) => r.source_policy?.deletion_semantics === "full_excise");
  check("T1.e every row carries full_excise deletion_semantics", allFullExcise);
  check("T1.f every row has source=github-events", rows.every((r) => r.source === SOURCE));
  check("T1.g every row carries gh-event: source_msg_id prefix", rows.every((r) => typeof r.source_msg_id === "string" && r.source_msg_id.startsWith("gh-event:")));
  check("T1.h every row carries checksum (hex 32)", rows.every((r) => /^[0-9a-f]{32}$/.test(r.checksum || "")));
  check("T1.i raw_content event_type stamped", rows.every((r) => typeof r.raw_content?.event_type === "string"));
  check("T1.j parties[0] is 'user'", rows.every((r) => Array.isArray(r.parties) && r.parties[0] === "user"));

  // Cursor side-effects
  const state = JSON.parse(readFileSync(connectorStatePath(SOURCE), "utf8"));
  check("T1.k cursor username persisted", state.username === USERNAME);
  check("T1.l cursor last_event_id is the highest fixture id", state.last_event_id === FIRST_PARTY_EVENTS[FIRST_PARTY_EVENTS.length - 1].id);
  check("T1.m cursor status=ok", state.status === "ok");
}

// ===========================================================================
// T2 — events on others' repos -> consent_basis=third_party_inferred
// ===========================================================================
console.log("\n--- T2: third-party-inferred classifier on others' repos ---");
{
  rmLedger();
  const connector = new GitHubEventsConnector({ username: USERNAME });
  const res = await connector.pollOnce({
    _whoami: USERNAME,
    _fixtureEvents: THIRD_PARTY_EVENTS,
    now: () => new Date("2026-06-02T00:00:00.000Z"),
  });
  check("T2.a three third-party events appended", res.appended === THIRD_PARTY_EVENTS.length, JSON.stringify(res));
  const rows = readRows();
  check("T2.b ledger has 3 rows", rows.length === THIRD_PARTY_EVENTS.length, `got ${rows.length}`);
  const allThirdParty = rows.every((r) => r.source_policy?.consent_basis === "third_party_inferred");
  check("T2.c every row classified third_party_inferred", allThirdParty);
  // parties[] should include the repo owner (gh:<owner>) for third-party rows.
  const allHaveExternalParty = rows.every((r) => r.parties.some((p) => p.startsWith("gh:") && p !== `gh:${USERNAME}`));
  check("T2.d every row includes an external party tag", allHaveExternalParty);
}

// ===========================================================================
// T3 — cursor restart: runOnce twice; second appends 0
// ===========================================================================
console.log("\n--- T3: cursor restart ---");
{
  rmLedger();
  const connector1 = new GitHubEventsConnector({ username: USERNAME });
  const r1 = await connector1.pollOnce({
    _whoami: USERNAME,
    _fixtureEvents: FIXTURES,
    now: () => new Date("2026-06-02T00:00:00.000Z"),
  });
  check("T3.a first poll ingests all 8 fixtures", r1.appended === FIXTURES.length, JSON.stringify(r1));

  // Fresh connector instance simulates a daemon restart — it must read the
  // cursor and skip already-ingested events.
  const connector2 = new GitHubEventsConnector({});
  const r2 = await connector2.pollOnce({
    _whoami: USERNAME,
    _fixtureEvents: FIXTURES,
    now: () => new Date("2026-06-02T01:00:00.000Z"),
  });
  check("T3.b second poll appends 0", r2.appended === 0, JSON.stringify(r2));
  check("T3.c second poll skipped count equals fixture length", r2.skipped === FIXTURES.length, JSON.stringify(r2));
  check("T3.d second connector picked up persisted username", connector2.username === USERNAME);

  const rows = readRows();
  check("T3.e ledger still has only 8 rows", rows.length === FIXTURES.length, `got ${rows.length}`);
}

// ===========================================================================
// T4 — gh CLI missing / auth failure -> graceful degraded path
// ===========================================================================
console.log("\n--- T4: gh CLI missing / auth failure ---");
{
  rmLedger();
  const connector = new GitHubEventsConnector({});
  // Stub gh shell-out to simulate `gh` missing -> resolveUsername throws.
  const res = await connector.pollOnce({
    _ghExec: async () => ({ stdout: "", stderr: "gh: command not found", code: 127 }),
    now: () => new Date("2026-06-02T00:00:00.000Z"),
  });
  check("T4.a appended=0 on auth failure", res.appended === 0, JSON.stringify(res));
  check("T4.b errors=1 on auth failure", res.errors === 1, JSON.stringify(res));
  check("T4.c no ledger rows written", !existsSync(LEDGER_PATH) || readRows().length === 0);

  // Health reflects the failure.
  const state = JSON.parse(readFileSync(connectorStatePath(SOURCE), "utf8"));
  check("T4.d cursor status=failed", state.status === "failed", JSON.stringify(state));
  check("T4.e cursor error_count incremented", Number.isInteger(state.error_count) && state.error_count >= 1);
  const health = connector.reportHealth();
  check("T4.f reportHealth surfaces status=failed", health.status === "failed", JSON.stringify(health));

  // Second test variant: gh present but /users/<self>/events returns 403 rate-limit.
  rmLedger();
  const connector2 = new GitHubEventsConnector({ username: USERNAME });
  let call = 0;
  const res2 = await connector2.pollOnce({
    _whoami: USERNAME,
    _ghExec: async (args) => {
      call += 1;
      if (args[0] === "api" && /\/events/.test(args[1] || "")) {
        return { stdout: "", stderr: "rate limit exceeded HTTP 403", code: 1 };
      }
      return { stdout: "{}", stderr: "", code: 0 };
    },
    now: () => new Date("2026-06-02T00:30:00.000Z"),
  });
  check("T4.g rate-limit path -> appended=0, errors=1", res2.appended === 0 && res2.errors === 1, JSON.stringify(res2));
  const state2 = JSON.parse(readFileSync(connectorStatePath(SOURCE), "utf8"));
  check("T4.h rate-limit path does NOT set status=failed", state2.status !== "failed", JSON.stringify(state2));
  check("T4.i rate-limit path increments error_count", Number.isInteger(state2.error_count) && state2.error_count >= 1);
}

// ===========================================================================
// T5 — mixed-length event ids (Phase A1 HIGH-J). Real 2026 event ids are
// 13-digit (~5e13). The LRU sort + length-then-string compare must keep the
// 13-digit id as the highest after a poll that also includes a legacy
// 10-digit id (simulating a backfill or stale event).
// ===========================================================================
console.log("\n--- T5: mixed-length event ids LRU stability ---");
{
  rmLedger();
  const connector = new GitHubEventsConnector({ username: USERNAME });
  const mixed = [
    // Two real-shape 13-digit ids and one legacy 10-digit id.
    {
      id: "9999999999",
      type: "WatchEvent",
      actor: { id: 1, login: USERNAME },
      repo: { id: 100, name: `${USERNAME}/legacy` },
      payload: { action: "started" },
      public: true,
      created_at: "2026-06-01T09:00:00Z",
    },
    {
      id: "48319857234729",
      type: "PushEvent",
      actor: { id: 1, login: USERNAME },
      repo: { id: 100, name: `${USERNAME}/active` },
      payload: { ref: "refs/heads/main", commits: [], head: null },
      public: true,
      created_at: "2026-06-01T10:00:00Z",
    },
    {
      id: "48319857234730",
      type: "PushEvent",
      actor: { id: 1, login: USERNAME },
      repo: { id: 100, name: `${USERNAME}/active` },
      payload: { ref: "refs/heads/main", commits: [], head: null },
      public: true,
      created_at: "2026-06-01T10:05:00Z",
    },
  ];
  const res = await connector.pollOnce({
    _whoami: USERNAME,
    _fixtureEvents: mixed,
    now: () => new Date("2026-06-02T00:00:00.000Z"),
  });
  check("T5.a all three mixed-length events appended",
    res.appended === 3, JSON.stringify(res));
  const state = JSON.parse(readFileSync(connectorStatePath(SOURCE), "utf8"));
  // last_event_id must be the 13-digit max; length-then-string compare ranks
  // a 13-digit id as strictly greater than any 10-digit id.
  check("T5.b last_event_id is the 13-digit max",
    state.last_event_id === "48319857234730",
    `last_event_id=${state.last_event_id}`);
  // recent_event_ids must contain all three and end with the 13-digit max.
  const recent = Array.isArray(state.recent_event_ids) ? state.recent_event_ids : [];
  check("T5.c recent_event_ids contains all three",
    recent.length === 3 && recent.includes("9999999999") &&
    recent.includes("48319857234729") && recent.includes("48319857234730"),
    `recent=${JSON.stringify(recent)}`);
  check("T5.d recent_event_ids sort puts 13-digit ids last",
    recent[recent.length - 1] === "48319857234730" &&
    recent[0] === "9999999999",
    `recent=${JSON.stringify(recent)}`);
}

// ---------------------------------------------------------------------------
// Production-safety
// ---------------------------------------------------------------------------
let prodAfter = null;
try { const st = statSync(PROD_LEDGER); prodAfter = { mtimeMs: st.mtimeMs, size: st.size }; } catch {}
if (prodBefore != null && prodAfter != null) {
  const intact = prodBefore.mtimeMs === prodAfter.mtimeMs && prodBefore.size === prodAfter.size;
  check("PROD-SAFETY production memory.jsonl mtime+size unchanged", intact,
    `before=${JSON.stringify(prodBefore)} after=${JSON.stringify(prodAfter)}`);
}
let prodGhAfter = null;
try { const st = statSync(PROD_GH_LEDGER); prodGhAfter = { mtimeMs: st.mtimeMs, size: st.size }; } catch {}
if (prodGhBefore != null && prodGhAfter != null) {
  const intact = prodGhBefore.mtimeMs === prodGhAfter.mtimeMs && prodGhBefore.size === prodGhAfter.size;
  check("PROD-SAFETY production github-events.jsonl unchanged", intact,
    `before=${JSON.stringify(prodGhBefore)} after=${JSON.stringify(prodGhAfter)}`);
} else if (prodGhBefore == null && prodGhAfter != null) {
  failures += 1;
  console.error(`FAIL  PROD-SAFETY production github-events.jsonl was created during test — leak!`);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log(`\nAll github-events connector assertions passed.`);
