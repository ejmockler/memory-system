// whatsapp-f9-xsrc-dedup-contract.test.mjs
//
// F-NEW-W4-WHATSAPP-F9-XSRC-DEDUP-CONTRACT — end-to-end integration test.
//
// Asserts:
//   1. CROSS_SOURCE_CONTRACTS contains a whatsapp <-> imessage entry with
//      source_a="whatsapp", source_b="imessage", reason carrying the
//      F9 string, and the +/-5min window.
//   2. With a real iMessage ledger row on disk for (handle="+15551234567",
//      text="hello there long enough to clear the 25-char defang", ts T),
//      a synthetic WhatsApp event with the same canonicalized peer + the
//      same normalised text inside +/-5min causes the Stage-0 dispatcher
//      to return DROP with reason="whatsapp_cross_source_duplicate" AND
//      writes a quarantine entry whose .reason matches.
//   3. The control case (same WhatsApp event, NO matching iMessage ledger
//      row) returns PASS (or a non-F9 DROP, but not whatsapp_cross_source_
//      duplicate).
//   4. Out-of-window iMessage rows do NOT trigger the dup (only the +/-5min
//      band is positive).
//   5. Group chats (session_type=1) do NOT consult the substrate (substrate
//      returns is_dup=false for non-1:1 sessions).
//   6. Short text (< 25 normalised chars) does NOT trigger the dup even
//      with a matching iMessage row (Stage-0 short-text defang).
//
// HERMETIC: a tmpdir-scoped MEMORY_ROOT/STORAGE_BASE_DIR/QUARANTINE_BASE_DIR
// stack is set BEFORE any import of stage0/whatsapp or cross-source-dedup.
// No file under the default MEMORY_ROOT is touched.

import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// HERMETICITY: env vars MUST be set before dynamic-imports of any module
// that resolves STORAGE_DIR / QUARANTINE_BASE_DIR via config.js. Static
// imports above this fence (assert, node:fs, node:path, node:os) do not
// touch storage paths.
const TEST_ROOT = mkdtempSync(join(tmpdir(), "memsys-whatsapp-f9-xsrc-"));
const STORAGE = join(TEST_ROOT, "storage");
const QUARANTINE = join(TEST_ROOT, "storage", "quarantine");
mkdirSync(join(STORAGE, "sources"), { recursive: true });
mkdirSync(QUARANTINE, { recursive: true });
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.STORAGE_BASE_DIR = STORAGE;
process.env.QUARANTINE_BASE_DIR = QUARANTINE;
process.on("exit", () => {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
});

// Dynamic imports — must come AFTER env is set.
const { stage0: whatsappStage0 } = await import(
  "../../lib/ingest/stage0/whatsapp.js"
);
const {
  CROSS_SOURCE_CONTRACTS,
  _resetCachesForTest,
  checkCrossSourceDuplicate,
} = await import("../../lib/ingest/cross-source-dedup.js");

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Contract is registered.
// ---------------------------------------------------------------------------
const contract = CROSS_SOURCE_CONTRACTS.find(
  (c) => c.source_a === "whatsapp" && c.source_b === "imessage",
);
check(
  "CROSS_SOURCE_CONTRACTS has whatsapp <-> imessage entry",
  contract != null,
);
check(
  "whatsapp contract reason is whatsapp_cross_source_duplicate",
  contract && contract.reason === "whatsapp_cross_source_duplicate",
);
check(
  "whatsapp contract window is +/-5min",
  contract && contract.window_ms === 5 * 60 * 1000,
);
check(
  "whatsapp contract has extract_a + extract_b functions",
  contract
    && typeof contract.extract_a === "function"
    && typeof contract.extract_b === "function",
);

// ---------------------------------------------------------------------------
// Test fixtures.
// ---------------------------------------------------------------------------
const IMESSAGE_LEDGER = join(STORAGE, "sources", "imessage.jsonl");
const PEER_PHONE = "+15551234567";
const PEER_JID_LOCAL = "15551234567"; // bare-digit form after canonicalization
const MATCH_TEXT =
  "hello there long enough to clear the 25-char defang";
const PAIR_TS = "2026-06-07T14:30:00.000Z";
const PAIR_TS_MS = Date.parse(PAIR_TS);

// Write an iMessage ledger row whose canonicalized handle ("15551234567")
// + normalized text matches the WhatsApp side, within the +/-5min window.
function writeImessageRow({ handle_id, text, ts }) {
  const row = {
    ts,
    source: "imessage",
    source_msg_id: `im-${Math.random().toString(36).slice(2)}`,
    raw_content: {
      text,
      handle_id,
      is_from_me: 0,
    },
  };
  appendFileSync(IMESSAGE_LEDGER, JSON.stringify(row) + "\n");
}

function whatsappEvent({ text, session_type = 0, ts = PAIR_TS, is_from_me = 0 }) {
  return {
    source: "whatsapp",
    ts,
    source_msg_id: `wa-${Math.random().toString(36).slice(2)}`,
    raw_content: {
      text,
      from_jid: is_from_me
        ? `15550000001@s.whatsapp.net`
        : `${PEER_JID_LOCAL}@s.whatsapp.net`,
      to_jid: is_from_me
        ? `${PEER_JID_LOCAL}@s.whatsapp.net`
        : `15550000001@s.whatsapp.net`,
      session_jid: `${PEER_JID_LOCAL}@s.whatsapp.net`,
      is_from_me: is_from_me ? 1 : 0,
      message_type: 0,
      group_event_type: 0,
      session_type,
      has_media: false,
    },
  };
}

function readQuarantineEntries(source) {
  const dir = join(QUARANTINE, source);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    const buf = readFileSync(join(dir, file), "utf8");
    for (const line of buf.split("\n")) {
      if (line === "") continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

function resetWorkspace() {
  // Drop both ledger + quarantine between subtests so cached lookups
  // don't leak across cases.
  try { rmSync(IMESSAGE_LEDGER, { force: true }); } catch {}
  try { rmSync(QUARANTINE, { recursive: true, force: true }); } catch {}
  mkdirSync(QUARANTINE, { recursive: true });
  _resetCachesForTest();
}

// ---------------------------------------------------------------------------
// 2. Positive case — matching iMessage row triggers DROP + quarantine.
// ---------------------------------------------------------------------------
{
  resetWorkspace();
  writeImessageRow({
    handle_id: PEER_PHONE,
    text: MATCH_TEXT,
    ts: PAIR_TS,
  });
  const ev = whatsappEvent({ text: MATCH_TEXT });
  const result = whatsappStage0(ev);
  check(
    "matching iMessage row → DROP",
    result && result.decision === "DROP",
    `result=${JSON.stringify(result)}`,
  );
  check(
    "DROP reason is whatsapp_cross_source_duplicate",
    result && result.reason === "whatsapp_cross_source_duplicate",
  );
  const entries = readQuarantineEntries("whatsapp");
  check(
    "quarantine entry was written",
    entries.length === 1,
    `entries=${entries.length}`,
  );
  check(
    "quarantine entry .reason matches",
    entries[0] && entries[0].reason === "whatsapp_cross_source_duplicate",
  );
  check(
    "quarantine entry .rule_id points at the substrate wiring",
    entries[0]
      && typeof entries[0].rule_id === "string"
      && entries[0].rule_id.includes("F-NEW-W4-WHATSAPP-F9-XSRC-DEDUP-CONTRACT"),
  );
}

// ---------------------------------------------------------------------------
// 3. Negative case — NO matching iMessage row → no F9 DROP.
// ---------------------------------------------------------------------------
{
  resetWorkspace();
  // No iMessage ledger row exists at all (file may not exist).
  const ev = whatsappEvent({ text: MATCH_TEXT });
  const result = whatsappStage0(ev);
  check(
    "no iMessage row → not whatsapp_cross_source_duplicate",
    result && result.reason !== "whatsapp_cross_source_duplicate",
    `result=${JSON.stringify(result)}`,
  );
  // The synthetic event has substantive_prose-length text and no other DROP
  // signals — we expect a PASS.
  check(
    "no iMessage row → PASS",
    result && result.decision === "PASS",
  );
}

// ---------------------------------------------------------------------------
// 4. Out-of-window — iMessage row >5min away → no F9 DROP.
// ---------------------------------------------------------------------------
{
  resetWorkspace();
  // 10 minutes earlier — outside the +/-5min window.
  const farTs = new Date(PAIR_TS_MS - 10 * 60 * 1000).toISOString();
  writeImessageRow({
    handle_id: PEER_PHONE,
    text: MATCH_TEXT,
    ts: farTs,
  });
  const ev = whatsappEvent({ text: MATCH_TEXT });
  const result = whatsappStage0(ev);
  check(
    "out-of-window iMessage row → not whatsapp_cross_source_duplicate",
    result && result.reason !== "whatsapp_cross_source_duplicate",
    `result=${JSON.stringify(result)}`,
  );
}

// ---------------------------------------------------------------------------
// 5. Group chat — session_type=1 (group) bypasses the contract entirely.
// ---------------------------------------------------------------------------
{
  resetWorkspace();
  writeImessageRow({
    handle_id: PEER_PHONE,
    text: MATCH_TEXT,
    ts: PAIR_TS,
  });
  const ev = whatsappEvent({ text: MATCH_TEXT, session_type: 1 });
  const result = whatsappStage0(ev);
  check(
    "group chat (session_type=1) → not whatsapp_cross_source_duplicate",
    result && result.reason !== "whatsapp_cross_source_duplicate",
    `result=${JSON.stringify(result)}`,
  );
}

// ---------------------------------------------------------------------------
// 6. Short text — Stage-0 defang prevents the substrate lookup.
// ---------------------------------------------------------------------------
{
  resetWorkspace();
  writeImessageRow({
    handle_id: PEER_PHONE,
    text: "ok",
    ts: PAIR_TS,
  });
  const ev = whatsappEvent({ text: "ok" });
  const result = whatsappStage0(ev);
  check(
    "short text → not whatsapp_cross_source_duplicate",
    result && result.reason !== "whatsapp_cross_source_duplicate",
    `result=${JSON.stringify(result)}`,
  );
}

// ---------------------------------------------------------------------------
// 7. Substrate direct check — extract_a returns null for non-1:1 sessions.
// ---------------------------------------------------------------------------
{
  resetWorkspace();
  // Direct substrate exercise to verify the contract's extract_a gating.
  const groupEv = whatsappEvent({ text: MATCH_TEXT, session_type: 1 });
  const xsrc = checkCrossSourceDuplicate(groupEv, "whatsapp");
  check(
    "checkCrossSourceDuplicate returns is_dup=false for group chats",
    xsrc && xsrc.is_dup === false,
    `xsrc=${JSON.stringify(xsrc)}`,
  );
}

// ---------------------------------------------------------------------------
// 8. Substrate direct check — positive contract round-trip.
// ---------------------------------------------------------------------------
{
  resetWorkspace();
  writeImessageRow({
    handle_id: PEER_PHONE,
    text: MATCH_TEXT,
    ts: PAIR_TS,
  });
  const ev = whatsappEvent({ text: MATCH_TEXT });
  const xsrc = checkCrossSourceDuplicate(ev, "whatsapp");
  check(
    "checkCrossSourceDuplicate returns is_dup=true on positive match",
    xsrc && xsrc.is_dup === true,
    `xsrc=${JSON.stringify(xsrc)}`,
  );
  check(
    "substrate hit identifies paired_source=imessage",
    xsrc && xsrc.paired_source === "imessage",
  );
  check(
    "substrate hit identifies contract=whatsapp-imessage",
    xsrc && xsrc.contract === "whatsapp-imessage",
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
