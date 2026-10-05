// slack-connector.test.mjs — R38 Phase 2c Slack connector tests.
//
// Exercises lib/connectors/slack.js against the synthetic Slack API fixture
// at test/fixtures/slack-fixture.json. NEVER hits slack.com.
//
// Edge cases covered (task-spec'd T1..T7 + supporting smoke):
//   T1: DM → first_party for operator-authored, third_party_inferred
//       for peer-authored (post F-T2-SLACK-F7 Wave 2 tightening; was
//       first_party in both directions per the Phase A spec, which the
//       audit flagged as over-collecting peer consent).
//   T2: private channel → first_party for own user_id, third_party_inferred otherwise
//   T3: public channel → first_party for own user_id, public_observation otherwise
//   T4: bot_id message → Stage-0 DROP
//   T5: channel_join event → Stage-0 DROP
//   T6: deterministic source_msg_id
//   T7: cursor advancement persists across reruns
//
// HERMETICITY: env vars set BEFORE the dynamic import; fetch is stubbed via
// opts.fetchImpl so no socket is ever opened. Production memory.jsonl is
// snapshot-checked pre/post and the test fails if it drifts.
//
// KEY_LEAKAGE_ZERO: fixture content references only placeholder IDs (T01,
// C01, D01, G01, U01) and ALPHA/BETA placeholder strings; no real Slack
// tokens, no real workspace IDs, no operator dialog.
//
// Run: node test/slack-connector.test.mjs

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

// ---------------------------------------------------------------------------
// Hermetic root + env wiring — MUST precede dynamic imports.
// ---------------------------------------------------------------------------
const TEST_ROOT = mkdtempSync(join(tmpdir(), "slack-conn-test-"));
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

// Production-safety snapshot.
const PROD_LEDGER = join(homedir(), "memory-system", "ledgers", "memory.jsonl");
let prodBefore = null;
try {
  const st = statSync(PROD_LEDGER);
  prodBefore = { mtimeMs: st.mtimeMs, size: st.size };
} catch {}

// ---------------------------------------------------------------------------
// Dynamic imports.
// ---------------------------------------------------------------------------
const { SlackConnector, _internals } = await import("../lib/connectors/slack.js");
const { STORAGE_DIR } = await import("../lib/config.js");

// ---------------------------------------------------------------------------
// Fixture + stub fetch.
// ---------------------------------------------------------------------------
const FIXTURE_PATH = join(import.meta.dirname, "fixtures", "slack-fixture.json");
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

// Stub fetch: route Slack API methods to the corresponding fixture key.
//   auth.test                  -> FIXTURE.auth_test_<workspace_id>
//   conversations.list         -> FIXTURE.conversations_list_<workspace_id>
//   conversations.history      -> FIXTURE.conversations_history_<channel_id>
//
// We assume the test runs a single workspace; the fixture is keyed by
// T01ALPHA. Errors surface as fetch-side 500s (never hit in this test).
function makeStubFetch() {
  const callLog = [];
  async function stubFetch(url, opts) {
    callLog.push({ url, body: opts && opts.body });
    const method = url.split("/").pop();
    let body;
    if (method === "auth.test") {
      body = FIXTURE.auth_test_T01ALPHA;
    } else if (method === "conversations.list") {
      body = FIXTURE.conversations_list_T01ALPHA;
    } else if (method === "conversations.history") {
      const params = new URLSearchParams(opts.body);
      const channel = params.get("channel");
      const key = `conversations_history_${channel}`;
      body = FIXTURE[key];
      if (!body) {
        body = { ok: true, has_more: false, messages: [], response_metadata: { next_cursor: "" } };
      }
    } else {
      body = { ok: false, error: "unknown_method" };
    }
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      async json() { return body; },
    };
  }
  return { stubFetch, callLog };
}

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

function readLedger() {
  const path = join(STORAGE_DIR, "sources", "slack.jsonl");
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8").trim();
  if (raw === "") return [];
  return raw.split("\n").map((l) => JSON.parse(l));
}

function clearLedger() {
  const path = join(STORAGE_DIR, "sources", "slack.jsonl");
  try { rmSync(path); } catch {}
}

function clearConnectorDir() {
  rmSync(join(TEST_ROOT, "connectors"), { recursive: true, force: true });
  mkdirSync(join(TEST_ROOT, "connectors"), { recursive: true });
}

function clearChannelCursors() {
  rmSync(join(STORAGE_DIR, "sources", "slack-cursors"), { recursive: true, force: true });
}

function makeConnector(opts = {}) {
  const { stubFetch } = opts.stub || makeStubFetch();
  return new SlackConnector({
    userToken: "xoxp-test-token-PLACEHOLDER",
    workspaceIds: ["T01ALPHA"],
    apiBase: "https://stub.invalid/api",
    fetchImpl: stubFetch,
    selfUserIds: { T01ALPHA: "U01OPERATOR" },
    ...opts.overrides,
  });
}

// ===========================================================================
// T0 — _internals helpers smoke
// ===========================================================================
console.log("\n--- T0: internals smoke ---");
{
  check(
    "T0.a classifyChannelKind im",
    _internals.classifyChannelKind({ is_im: true }) === "im",
  );
  check(
    "T0.b classifyChannelKind mpim",
    _internals.classifyChannelKind({ is_mpim: true }) === "mpim",
  );
  check(
    "T0.c classifyChannelKind private",
    _internals.classifyChannelKind({ is_private: true }) === "private_channel",
  );
  check(
    "T0.d classifyChannelKind public default",
    _internals.classifyChannelKind({}) === "public_channel",
  );
  // F-T2-SLACK-F7: DM peer authorship is now third_party_inferred (was
  // first_party in the Phase A spec). Own DM messages remain first_party.
  check(
    "T0.e classifyConsent im peer → third_party_inferred (F-T2-SLACK-F7)",
    _internals.classifyConsent("im", "U01PEER1", "U01OPERATOR") === "third_party_inferred",
  );
  check(
    "T0.e2 classifyConsent im own → first_party (F-T2-SLACK-F7)",
    _internals.classifyConsent("im", "U01OPERATOR", "U01OPERATOR") === "first_party",
  );
  check(
    "T0.f classifyConsent private own → first_party",
    _internals.classifyConsent("private_channel", "U01OPERATOR", "U01OPERATOR") === "first_party",
  );
  check(
    "T0.g classifyConsent private other → third_party_inferred",
    _internals.classifyConsent("private_channel", "U01PEER1", "U01OPERATOR") === "third_party_inferred",
  );
  check(
    "T0.h classifyConsent public other → public_observation",
    _internals.classifyConsent("public_channel", "U01PEER1", "U01OPERATOR") === "public_observation",
  );
  check(
    "T0.i parseWorkspaceIds csv",
    JSON.stringify(_internals.parseWorkspaceIds("T01,T02,T03")) === '["T01","T02","T03"]',
  );
  // slackTsToIso uses the seconds + microsecond payload.
  const iso = _internals.slackTsToIso("1730000000.123456");
  check(
    "T0.j slackTsToIso shape",
    typeof iso === "string" && iso.endsWith("Z") && iso.includes("2024"),
    iso,
  );
}

// ===========================================================================
// T1 — DM consent: own=first_party, peer=third_party_inferred
//      (post F-T2-SLACK-F7 Wave 2 tightening).
// ===========================================================================
console.log("\n--- T1: DM → own first_party / peer third_party_inferred ---");
{
  clearLedger();
  clearConnectorDir();
  clearChannelCursors();

  const c = makeConnector();
  const res = await c.pollOnce();

  check("T1.a pollOnce returns no errors", res.errors === 0, JSON.stringify(res));
  check("T1.b channels=4 enumerated", res.channels === 4, JSON.stringify(res));

  const rows = readLedger();
  const dmRows = rows.filter((r) => r.raw_content?.channel_id === "D01DM00001");
  check("T1.c 2 DM rows on disk", dmRows.length === 2, `got ${dmRows.length}`);
  const ownDm = dmRows.find((r) => r.raw_content?.user === "U01OPERATOR");
  const peerDm = dmRows.find((r) => r.raw_content?.user === "U01PEER1");
  check(
    "T1.d operator-authored DM consent=first_party",
    ownDm?.source_policy?.consent_basis === "first_party",
    JSON.stringify(ownDm?.source_policy),
  );
  check(
    "T1.e both DM rows deletion_semantics=full_excise",
    dmRows.every((r) => r.source_policy?.deletion_semantics === "full_excise"),
  );
  check(
    "T1.f peer-authored DM consent=third_party_inferred (F-T2-SLACK-F7)",
    peerDm?.source_policy?.consent_basis === "third_party_inferred",
    JSON.stringify(peerDm?.source_policy),
  );
}

// ===========================================================================
// T2 — private channel: own=first_party, other=third_party_inferred
// ===========================================================================
console.log("\n--- T2: private channel → own vs other consent ---");
{
  const rows = readLedger();
  const privRows = rows.filter((r) => r.raw_content?.channel_id === "C01PRIV001");
  // 3 input messages — 1 own + 1 other + 1 channel_join (Stage-0 drop).
  check("T2.a 2 private rows on disk (channel_join dropped)", privRows.length === 2, `got ${privRows.length}`);
  const own = privRows.find((r) => r.raw_content?.user === "U01OPERATOR");
  const other = privRows.find((r) => r.raw_content?.user === "U01PEER3");
  check("T2.b own row exists", own != null);
  check("T2.c other row exists", other != null);
  check(
    "T2.d own row consent=first_party",
    own?.source_policy?.consent_basis === "first_party",
    JSON.stringify(own?.source_policy?.consent_basis),
  );
  check(
    "T2.e other row consent=third_party_inferred",
    other?.source_policy?.consent_basis === "third_party_inferred",
    JSON.stringify(other?.source_policy?.consent_basis),
  );
}

// ===========================================================================
// T3 — public channel: own=first_party, other=public_observation
// ===========================================================================
console.log("\n--- T3: public channel → own vs observer consent ---");
{
  const rows = readLedger();
  const pubRows = rows.filter((r) => r.raw_content?.channel_id === "C01PUB0001");
  // 4 input — 1 own + 1 other + 1 bot_message (Stage-0 drop) + 1 file_share no text (Stage-0 drop)
  check("T3.a 2 public rows on disk (bot + file_share dropped)", pubRows.length === 2, `got ${pubRows.length}`);
  const own = pubRows.find((r) => r.raw_content?.user === "U01OPERATOR");
  const other = pubRows.find((r) => r.raw_content?.user === "U01PEER5");
  check("T3.b own row exists", own != null);
  check("T3.c other row exists", other != null);
  check(
    "T3.d own row consent=first_party",
    own?.source_policy?.consent_basis === "first_party",
  );
  check(
    "T3.e other row consent=public_observation",
    other?.source_policy?.consent_basis === "public_observation",
    JSON.stringify(other?.source_policy?.consent_basis),
  );
}

// ===========================================================================
// T4 — bot_id / bot_message subtype → Stage-0 DROP
// ===========================================================================
console.log("\n--- T4: bot_message Stage-0 DROP ---");
{
  const rows = readLedger();
  const botRows = rows.filter((r) => r.raw_content?.is_bot === true || r.raw_content?.subtype === "bot_message");
  check("T4.a no bot rows survived to ledger", botRows.length === 0);
  // Direct Stage-0 verdict probe.
  const { stage0 } = await import("../lib/ingest/stage0/slack.js");
  const v1 = stage0({
    source: "slack",
    raw_content: { is_bot: true, text: "hello" },
  });
  check("T4.b direct stage0 returns DROP for is_bot=true", v1.decision === "DROP" && v1.reason === "bot_message");
  const v2 = stage0({
    source: "slack",
    raw_content: { subtype: "bot_message", text: "hello" },
  });
  check("T4.c direct stage0 returns DROP for subtype=bot_message", v2.decision === "DROP" && v2.reason === "bot_message");
}

// ===========================================================================
// T5 — channel_join event → Stage-0 DROP
// ===========================================================================
console.log("\n--- T5: channel_join Stage-0 DROP ---");
{
  const rows = readLedger();
  const lifecycleRows = rows.filter((r) => {
    const s = r.raw_content?.subtype;
    return s === "channel_join" || s === "channel_leave" || s === "channel_topic";
  });
  check("T5.a no lifecycle rows survived to ledger", lifecycleRows.length === 0);
  const { stage0 } = await import("../lib/ingest/stage0/slack.js");
  const v = stage0({
    source: "slack",
    raw_content: { subtype: "channel_join", text: "<@x> joined", is_bot: false },
  });
  check("T5.b direct stage0 returns DROP for channel_join", v.decision === "DROP" && v.reason === "channel_lifecycle");
  const v2 = stage0({
    source: "slack",
    raw_content: { subtype: "channel_leave", text: "<@x> left", is_bot: false },
  });
  check("T5.c direct stage0 returns DROP for channel_leave", v2.decision === "DROP" && v2.reason === "channel_lifecycle");
  const v3 = stage0({
    source: "slack",
    raw_content: { subtype: "file_share", text: "", has_files: true, is_bot: false },
  });
  check("T5.d direct stage0 returns DROP for file_share empty", v3.decision === "DROP" && v3.reason === "file_share_no_text");
}

// ===========================================================================
// T6 — deterministic source_msg_id
// ===========================================================================
console.log("\n--- T6: deterministic source_msg_id across reruns ---");
{
  const baselineIds = readLedger().map((r) => r.source_msg_id).sort();

  // Fresh-cursor poll on the existing ledger: dedup via base class.
  clearConnectorDir();
  clearChannelCursors();
  const c = makeConnector();
  const res = await c.pollOnce();

  check("T6.a fresh-cursor poll appends 0 (dedup)", res.appended === 0, JSON.stringify(res));
  const afterIds = readLedger().map((r) => r.source_msg_id).sort();
  check(
    "T6.b source_msg_id set identical after restart",
    JSON.stringify(afterIds) === JSON.stringify(baselineIds),
    `before=${baselineIds.length} after=${afterIds.length}`,
  );
  // Deterministic shape.
  const expectedDmFirst = "slack:T01ALPHA:D01DM00001:1730000010.000200";
  check(
    "T6.c first DM source_msg_id matches deterministic shape",
    baselineIds.includes(expectedDmFirst),
    `looking for ${expectedDmFirst}; got ids: ${JSON.stringify(baselineIds.slice(0, 4))}`,
  );
}

// ===========================================================================
// T7 — cursor advancement persists across reruns
// ===========================================================================
console.log("\n--- T7: per-channel cursor advancement persists ---");
{
  // After T1+T6, every channel cursor should hold the last (newest) ts.
  const dmCursorPath = join(STORAGE_DIR, "sources", "slack-cursors", "T01ALPHA", "D01DM00001.json");
  check("T7.a DM cursor file exists", existsSync(dmCursorPath));
  const dmCursor = JSON.parse(readFileSync(dmCursorPath, "utf8"));
  check(
    "T7.b DM cursor last_ts = 1730000020.000300",
    dmCursor.last_ts === "1730000020.000300",
    JSON.stringify(dmCursor),
  );
  check(
    "T7.c DM cursor last_polled_ts populated",
    typeof dmCursor.last_polled_ts === "string" && dmCursor.last_polled_ts !== "",
  );

  const privCursorPath = join(STORAGE_DIR, "sources", "slack-cursors", "T01ALPHA", "C01PRIV001.json");
  check("T7.d private cursor file exists", existsSync(privCursorPath));
  const privCursor = JSON.parse(readFileSync(privCursorPath, "utf8"));
  check(
    "T7.e private cursor advanced past channel_join ts",
    privCursor.last_ts === "1730000215.000010",
    JSON.stringify(privCursor),
  );
}

// ===========================================================================
// T8 — refuses to start without token
// ===========================================================================
console.log("\n--- T8: refuses to start without token ---");
{
  let threw = false;
  let msg = "";
  try {
    const c = new SlackConnector({
      userToken: "",
      workspaceIds: ["T01ALPHA"],
      apiBase: "https://stub.invalid/api",
      fetchImpl: makeStubFetch().stubFetch,
    });
    c.assertConfigured();
  } catch (e) {
    threw = true;
    msg = String(e.message || "");
  }
  check("T8.a missing token throws", threw);
  check(
    "T8.b error message mentions SLACK_USER_TOKEN",
    msg.includes("SLACK_USER_TOKEN"),
    msg,
  );
}

// ---------------------------------------------------------------------------
// Production-safety: confirm we never wrote to the real memory.jsonl.
// ---------------------------------------------------------------------------
let prodAfter = null;
try {
  const st = statSync(PROD_LEDGER);
  prodAfter = { mtimeMs: st.mtimeMs, size: st.size };
} catch {}
if (prodBefore != null && prodAfter != null) {
  const intact = prodBefore.mtimeMs === prodAfter.mtimeMs && prodBefore.size === prodAfter.size;
  check(
    "PROD-SAFETY production memory.jsonl mtime+size unchanged",
    intact,
    `before=${JSON.stringify(prodBefore)} after=${JSON.stringify(prodAfter)}`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log(`\nAll slack-connector assertions passed.`);
