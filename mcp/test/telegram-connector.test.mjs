// telegram-connector.test.mjs — R38 Phase 2c Telegram connector tests.
//
// Exercises lib/connectors/telegram.js against the synthetic JSONL fixture
// at test/fixtures/telegram-fixture.jsonl. NEVER reads a real Telegram
// session or contacts the MTProto API.
//
// HERMETICITY: env vars set BEFORE the dynamic import; the fixture is
// copied to a staging file inside TEST_ROOT and TELEGRAM_STAGING_FILE points
// at it. Production <checkout>/storage/sources/telegram.jsonl
// is never written; the test snapshots production memory.jsonl pre/post
// and fails on drift.
//
// KEY_LEAKAGE_ZERO: fixture content references only placeholder strings
// ("alpha_contact", "self_op", "BETA_user", "PLACEHOLDER_GROUP",
// "PLACEHOLDER_CHANNEL", "announce_bot"); no real session strings, no real
// phone numbers, no real chat content.
//
// Edge cases:
//   T1: 1:1 message -> first_party row, content matches text.
//   T2: group message -> first_party for outgoing/is_self, third_party_inferred
//       otherwise.
//   T3: channel broadcast -> Stage-0 DROP via quarantineRow (F-T2-TELEGRAM-F3).
//       Operator-owned (is_outgoing) and allowlisted (CAPS.TELEGRAM_CHANNEL_
//       ALLOWLIST) channels are preserved; see _internals carve-outs.
//   T4: bot message -> Stage-0 DROP (bot_message).
//   T5: deterministic source_msg_id across re-runs of same fixture.
//   T6: sticker-only with no caption -> Stage-0 DROP.
//   T7: voice metadata-only -> Stage-0 DROP.
//   T8: ephemeral TTL <= 7d -> Stage-0 DROP, except is_self
//       (F-T2-TELEGRAM-F5 widens threshold from 1d to 7d).
//
// Run: node mcp/test/telegram-connector.test.mjs

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Hermetic root + env wiring — MUST precede dynamic imports.
// ---------------------------------------------------------------------------
const TEST_ROOT = mkdtempSync(join(tmpdir(), "telegram-conn-test-"));
mkdirSync(join(TEST_ROOT, "policy"), { recursive: true });
mkdirSync(join(TEST_ROOT, "ledgers"), { recursive: true });
mkdirSync(join(TEST_ROOT, "storage", "sources"), { recursive: true });
mkdirSync(join(TEST_ROOT, "connectors"), { recursive: true });
mkdirSync(join(TEST_ROOT, "staging"), { recursive: true });
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
process.env.CONNECTORS_BASE_DIR = join(TEST_ROOT, "connectors");

const STAGING_FILE = join(TEST_ROOT, "staging", "telegram-staging.jsonl");
process.env.TELEGRAM_STAGING_FILE = STAGING_FILE;

process.on("exit", () => {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
});

// Production-safety snapshot.
// Checkout root, derived from this file's location (never from the home dir
// or the environment, which the suite may redirect to a temp tree).
const CHECKOUT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROD_LEDGER = join(CHECKOUT_ROOT, "ledgers", "memory.jsonl");
// Snapshot as "missing" when absent, so a run that CREATES the ledger fails
// the guard too (a fresh checkout has no ledgers/memory.jsonl).
function snap(p) {
  try {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "missing";
  }
}
const prodBefore = snap(PROD_LEDGER);

// ---------------------------------------------------------------------------
// Dynamic imports.
// ---------------------------------------------------------------------------
const { TelegramConnector, _internals, defaultStagingFile } = await import("../lib/connectors/telegram.js");
const { STORAGE_DIR } = await import("../lib/config.js");

// ---------------------------------------------------------------------------
// Fixture staging: copy fixture into the staging file path.
// ---------------------------------------------------------------------------
const FIXTURE_SRC = join(import.meta.dirname, "fixtures", "telegram-fixture.jsonl");
copyFileSync(FIXTURE_SRC, STAGING_FILE);

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
  const path = join(STORAGE_DIR, "sources", "telegram.jsonl");
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8").trim();
  if (raw === "") return [];
  return raw.split("\n").map((l) => JSON.parse(l));
}

function readCursorFile() {
  const path = join(TEST_ROOT, "connectors", "telegram", "state.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function clearLedger() {
  const path = join(STORAGE_DIR, "sources", "telegram.jsonl");
  try { rmSync(path); } catch {}
}

function clearConnectorDir() {
  rmSync(join(TEST_ROOT, "connectors"), { recursive: true, force: true });
  mkdirSync(join(TEST_ROOT, "connectors"), { recursive: true });
}

// ===========================================================================
// T0 — internals smoke (consent + id determinism)
// ===========================================================================
console.log("\n--- T0: internals smoke ---");
{
  check(
    "T0.a classifyConsent(user, outgoing) -> first_party",
    _internals.classifyConsent({ peer_type: "user", is_outgoing: true, is_self: true }) === "first_party",
  );
  check(
    "T0.b classifyConsent(user, incoming) -> first_party",
    _internals.classifyConsent({ peer_type: "user", is_outgoing: false, is_self: false }) === "first_party",
  );
  check(
    "T0.c classifyConsent(group, outgoing) -> first_party",
    _internals.classifyConsent({ peer_type: "group", is_outgoing: true, is_self: true }) === "first_party",
  );
  check(
    "T0.d classifyConsent(group, incoming/other) -> third_party_inferred",
    _internals.classifyConsent({ peer_type: "group", is_outgoing: false, is_self: false }) === "third_party_inferred",
  );
  check(
    "T0.e classifyConsent(channel) -> public_observation",
    _internals.classifyConsent({ peer_type: "channel", is_outgoing: false, is_self: false }) === "public_observation",
  );
  const idA = _internals.computeSourceMsgId(1000001, 1);
  const idB = _internals.computeSourceMsgId(1000001, 1);
  check("T0.f computeSourceMsgId deterministic", idA === idB, `${idA} vs ${idB}`);
  check("T0.g source_msg_id starts with tg_", idA.startsWith("tg_"));
}

// ===========================================================================
// T1..T8 — connector + Stage-0 against the 9-event fixture.
// ===========================================================================
console.log("\n--- T1..T8: fixture run ---");
{
  clearLedger();
  clearConnectorDir();

  const c = new TelegramConnector({ stagingFile: STAGING_FILE });
  const res = await c.pollOnce();

  // Fixture has 9 events. Stage-0 drops 5:
  //   msg_id 13 -> bot_message (sender_name "announce_bot")
  //   msg_id  3 -> sticker_only (sticker + empty text)
  //   msg_id  4 -> voice_video_metadata_only (voice + empty text)
  //   msg_id  5 -> ephemeral_short_ttl (ttl_seconds=3600, is_self=false)
  //   msg_id 21 -> channel_broadcast (F-T2-TELEGRAM-F3, quarantined)
  // Net appended: 4.
  check("T1.0 appended=4", res.appended === 4, JSON.stringify(res));
  check("T1.0 errors=0", res.errors === 0, JSON.stringify(res));

  const rows = readLedger();
  check("T1.0 4 rows on disk", rows.length === 4, `got ${rows.length}`);

  // T1: 1:1 message -> first_party + content matches text.
  const oneToOne = rows.find((r) => r.raw_content?.message_id === 1);
  check("T1.a msg_id=1 row present (incoming DM)", oneToOne != null);
  check(
    "T1.b 1:1 incoming consent_basis=first_party",
    oneToOne?.source_policy?.consent_basis === "first_party",
    JSON.stringify(oneToOne?.source_policy),
  );
  check(
    "T1.c content equals text",
    oneToOne?.content === "hello from a 1:1 DM with placeholder text only",
    JSON.stringify(oneToOne?.content),
  );

  // T2: group message — operator outgoing -> first_party; other sender -> third_party_inferred.
  const groupOut = rows.find((r) => r.raw_content?.message_id === 11);
  const groupIn = rows.find((r) => r.raw_content?.message_id === 12);
  check("T2.a msg_id=11 row (group outgoing) present", groupOut != null);
  check("T2.b msg_id=12 row (group incoming) present", groupIn != null);
  check(
    "T2.c group outgoing consent_basis=first_party",
    groupOut?.source_policy?.consent_basis === "first_party",
    JSON.stringify(groupOut?.source_policy),
  );
  check(
    "T2.d group incoming consent_basis=third_party_inferred",
    groupIn?.source_policy?.consent_basis === "third_party_inferred",
    JSON.stringify(groupIn?.source_policy),
  );

  // T3: channel broadcast -> DROP via F-T2-TELEGRAM-F3 (quarantined). The
  // row no longer appears in the source-ledger; it's recoverable from the
  // quarantine layer if the operator engages with the channel.
  const channelRow = rows.find((r) => r.raw_content?.message_id === 21);
  check("T3.a msg_id=21 (channel broadcast) was DROPped (not in ledger)", channelRow == null);

  // T4: bot message dropped (msg_id 13 absent).
  const botRow = rows.find((r) => r.raw_content?.message_id === 13);
  check("T4.a bot msg_id=13 was DROPped (not in ledger)", botRow == null);

  // T6: sticker-only dropped (msg_id 3 absent).
  const stickerRow = rows.find((r) => r.raw_content?.message_id === 3);
  check("T6.a sticker-only msg_id=3 was DROPped", stickerRow == null);

  // T7: voice metadata dropped.
  const voiceRow = rows.find((r) => r.raw_content?.message_id === 4);
  check("T7.a voice metadata-only msg_id=4 was DROPped", voiceRow == null);

  // T8: ephemeral TTL dropped.
  const ttlRow = rows.find((r) => r.raw_content?.message_id === 5);
  check("T8.a ephemeral ttl msg_id=5 was DROPped", ttlRow == null);

  // Shape-level checks:
  check("T*.a all rows source=telegram", rows.every((r) => r.source === "telegram"));
  check(
    "T*.b all rows source_msg_id start with tg_",
    rows.every((r) => typeof r.source_msg_id === "string" && r.source_msg_id.startsWith("tg_")),
  );
  check(
    "T*.c all rows deletion_semantics=full_excise",
    rows.every((r) => r.source_policy?.deletion_semantics === "full_excise"),
  );
  check(
    "T*.d row id begins with ulid_",
    rows.every((r) => typeof r.id === "string" && r.id.startsWith("ulid_")),
  );
  check(
    "T*.e checksum is 32 hex chars",
    rows.every((r) => /^[0-9a-f]{32}$/.test(r.checksum || "")),
  );

  // Cursor checks.
  const state = readCursorFile();
  check("T*.f cursor file exists", state != null);
  const stagingBytes = statSync(STAGING_FILE).size;
  check(
    "T*.g staging_offset advanced to full file size",
    state?.staging_offset === stagingBytes,
    `state.staging_offset=${state?.staging_offset} stagingBytes=${stagingBytes}`,
  );
  check(
    "T*.h last_appended_ts populated",
    typeof state?.last_appended_ts === "string" && state.last_appended_ts !== "",
  );
}

// ===========================================================================
// T5 — deterministic source_msg_id across re-runs
// ===========================================================================
console.log("\n--- T5: deterministic source_msg_id across reruns ---");
{
  const baseline = readLedger().map((r) => r.source_msg_id).sort();
  // Wipe cursor; keep ledger. Re-run should append 0 (dedup via base class).
  clearConnectorDir();
  const c = new TelegramConnector({ stagingFile: STAGING_FILE });
  const res = await c.pollOnce();
  check("T5.a fresh-cursor poll appends 0 (dedup via base class)", res.appended === 0, JSON.stringify(res));
  const afterIds = readLedger().map((r) => r.source_msg_id).sort();
  check(
    "T5.b source_msg_id set is identical after restart",
    JSON.stringify(afterIds) === JSON.stringify(baseline),
    `before=${JSON.stringify(baseline)} after=${JSON.stringify(afterIds)}`,
  );
  // Determinism shape:
  const expected1 = _internals.computeSourceMsgId(1000001, 1);
  check(
    "T5.c msg_id=1 source_msg_id matches deterministic shape",
    baseline.includes(expected1),
    `expected=${expected1}`,
  );
}

// ===========================================================================
// T9 — partial trailing line is preserved across polls
// ===========================================================================
console.log("\n--- T9: partial trailing line preserved across polls ---");
{
  // Wipe everything and write a fresh staging file with one full line + one
  // partial (no trailing newline). The connector must NOT consume the partial.
  clearLedger();
  clearConnectorDir();
  const partialFile = join(TEST_ROOT, "staging", "telegram-staging-partial.jsonl");
  const fullLine = JSON.stringify({
    peer_type: "user", peer_id: 1000099, peer_name: "p", message_id: 901,
    ts: "2026-06-06T11:00:00.000Z", sender_id: 1000099, sender_name: "p",
    is_outgoing: false, is_self: false, text: "first complete line",
    media_type: null, fwd_from: null, reply_to: null, ttl_seconds: null, raw: {},
  });
  const partial = '{"peer_type":"user","peer_id":1000099';
  const { writeFileSync, appendFileSync } = await import("node:fs");
  writeFileSync(partialFile, fullLine + "\n" + partial);

  const c = new TelegramConnector({ stagingFile: partialFile });
  const res = await c.pollOnce();
  check("T9.a appended=1 (only the complete line)", res.appended === 1, JSON.stringify(res));
  // Now append the rest of the partial line.
  const rest = ',"peer_name":"p","message_id":902,"ts":"2026-06-06T11:01:00.000Z","sender_id":1000099,"sender_name":"p","is_outgoing":false,"is_self":false,"text":"second line completed across poll boundary","media_type":null,"fwd_from":null,"reply_to":null,"ttl_seconds":null,"raw":{}}\n';
  appendFileSync(partialFile, rest);
  const c2 = new TelegramConnector({ stagingFile: partialFile });
  const res2 = await c2.pollOnce();
  check("T9.b appended=1 on second poll (the now-complete line)", res2.appended === 1, JSON.stringify(res2));
}

// ===========================================================================
// T10 — staging file missing -> graceful skip, errors=0
// ===========================================================================
console.log("\n--- T10: missing staging file -> graceful skip ---");
{
  clearLedger();
  clearConnectorDir();
  const c = new TelegramConnector({
    stagingFile: join(TEST_ROOT, "no-such-staging.jsonl"),
  });
  const res = await c.pollOnce();
  check("T10.a appended=0", res.appended === 0, JSON.stringify(res));
  check("T10.b errors=0", res.errors === 0, JSON.stringify(res));
  check("T10.c ledger empty", readLedger().length === 0);
}

// ===========================================================================
// T11 — staging default: with TELEGRAM_STAGING_FILE unset the reader resolves
// <MEMORY_ROOT>/storage/tmp/telegram-staging.jsonl (the path the Python
// capture and the wrapper script default to); the variable still wins.
// ===========================================================================
console.log("\n--- T11: staging-file default under the data root ---");
{
  const expected = join(TEST_ROOT, "storage", "tmp", "telegram-staging.jsonl");
  const saved = process.env.TELEGRAM_STAGING_FILE;
  try {
    check("T11.a override wins while set", defaultStagingFile() === STAGING_FILE, defaultStagingFile());
    delete process.env.TELEGRAM_STAGING_FILE;
    check("T11.b unset -> <MEMORY_ROOT>/storage/tmp/telegram-staging.jsonl",
      defaultStagingFile() === expected, defaultStagingFile());
    check("T11.c connector with no option uses the default",
      new TelegramConnector({}).stagingFile === expected);
    process.env.TELEGRAM_STAGING_FILE = "";
    check("T11.d empty value falls back to the default", defaultStagingFile() === expected, defaultStagingFile());
    check("T11.e default is not under a shared temp directory", !defaultStagingFile().startsWith("/tmp/"));
  } finally {
    process.env.TELEGRAM_STAGING_FILE = saved;
  }
}

// ---------------------------------------------------------------------------
// Production-safety: confirm we never wrote to the real memory.jsonl.
// ---------------------------------------------------------------------------
const prodAfter = snap(PROD_LEDGER);
check("PROD-SAFETY production memory.jsonl mtime+size unchanged", prodBefore === prodAfter,
  `before=${prodBefore} after=${prodAfter}`);

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log(`\nAll telegram-connector assertions passed.`);
