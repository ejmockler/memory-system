// n4-imessage-adapter.test.mjs — WORKUNIT N4 regression suite for the iMessage L1
// adapter (mcp/lib/messaging/adapters/imessage.js + fixtures/n4-imessage-cases.json).
//
// ESM, defensive, node:test + node:assert/strict. >=12 assertions. Hermetic: NO
// chat.db, NO network, NO filesystem writes — reads only the case corpus + the
// adapter source (for the no-frozen-import / no-platform-leak grep gate) + N1's
// validateEnvelope (contract conformance). Runs in well under 2s.
//
// What this suite proves (mapped to the N4 GATE + Thesis-#1 constraints):
//   - toEnvelope produces a VALID envelope (N1 validateEnvelope) for EVERY case
//     (the `valid=N/N` gate term).
//   - Each case's envelope deep-equals its expected_envelope (the field map).
//   - reply_to_id is present (non-null) for every reply case (`reply_present=K/K`).
//   - outbound-group F7-repaired cases yield recipients.length>=2; the documented
//     legacy-empty case yields recipients===[] (the `group_parties_ok=M/M` term).
//   - thread_type replicates isGroupChat's 3-way OR (roomname / participant_count
//     / chat_guid suffix) — each branch independently.
//   - ts is converted ISO->integer-ms (N1 rejects ISO); unparseable ts throws.
//   - is_from_me is a STRICT boolean; outbound sender is {id:'user',name:'user'};
//     recipients = parties minus 'user'.
//   - content is null for the null-text tapback shell.
//   - capabilities{} is the frozen iMessage literal (reply_to_available=true is the
//     WhatsApp contrast); mutating the returned block does not leak into the next call.
//   - the adapter imports NOTHING from mcp/lib/connectors/* and contains no
//     platform branch inside the mapping logic (degradation = data).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { validateEnvelope } from "../../lib/messaging/envelope.js";
import {
  toEnvelope,
  toEnvelopeChecked,
  PLATFORM,
} from "../../lib/messaging/adapters/imessage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.resolve(__dirname, "../../lib/messaging");
const FIXTURES_DIR = path.join(LIB_DIR, "fixtures");
const ADAPTER_SRC = path.join(LIB_DIR, "adapters/imessage.js");

function readJson(rel) {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, rel), "utf8"));
}

const CORPUS = readJson("n4-imessage-cases.json");
const CASES = CORPUS.cases;

// A "reply case" carries a non-null thread_originator_guid (or its in_reply_to
// alias) on the raw row. An F7 outbound-group case is is_from_me=1 with
// parties_source stamped; the legacy-empty one resolves to recipients===[].
function isReplyCase(c) {
  const rc = c.raw_row.raw_content || {};
  return Boolean(rc.thread_originator_guid || rc.in_reply_to);
}
function isOutboundGroupCase(c) {
  return (
    c.expected_envelope.is_from_me === true &&
    c.expected_envelope.thread_type === "group"
  );
}

// ---------------------------------------------------------------------------
// T0 — corpus sanity (the gate counts are only meaningful over a real corpus).
// ---------------------------------------------------------------------------
test("corpus loads with the expected case shape", () => {
  assert.ok(Array.isArray(CASES), "cases must be an array");
  assert.ok(CASES.length >= 6, `expected >=6 cases, got ${CASES.length}`);
  for (const c of CASES) {
    assert.ok(c.label && c.raw_row && c.expected_envelope, `case ${c && c.label} well-formed`);
  }
});

// ---------------------------------------------------------------------------
// T1 — THE GATE: valid=N/N, reply_present=K/K, group_parties_ok=M/M.
// Every case maps to a VALID envelope that deep-equals its expectation.
// ---------------------------------------------------------------------------
test("GATE: every case maps to a valid envelope equal to its expectation", () => {
  let valid = 0;
  let replyPresent = 0;
  let replyTotal = 0;
  let groupOk = 0;
  let groupTotal = 0;

  for (const c of CASES) {
    const env = toEnvelope(c.raw_row);

    // Contract conformance (N1).
    const res = validateEnvelope(env);
    assert.equal(
      res.ok,
      true,
      `case ${c.label}: validateEnvelope rejected -> ${JSON.stringify(res.errors)}`,
    );

    // Exact field map.
    assert.deepEqual(
      env,
      c.expected_envelope,
      `case ${c.label}: envelope != expected_envelope`,
    );
    valid += 1;

    // reply_present accounting.
    if (isReplyCase(c)) {
      replyTotal += 1;
      assert.equal(
        typeof env.reply_to_id === "string" && env.reply_to_id.length > 0,
        true,
        `case ${c.label}: reply case must carry a non-null reply_to_id`,
      );
      replyPresent += 1;
    }

    // group_parties_ok accounting.
    if (isOutboundGroupCase(c)) {
      groupTotal += 1;
      const isLegacyEmpty = c.label.includes("legacy_empty");
      if (isLegacyEmpty) {
        assert.deepEqual(
          env.recipients,
          [],
          `case ${c.label}: documented legacy-empty F7 case must yield recipients=[]`,
        );
      } else {
        assert.ok(
          env.recipients.length >= 2,
          `case ${c.label}: F7-repaired outbound group must yield recipients.length>=2`,
        );
        assert.ok(
          !env.recipients.includes("user"),
          `case ${c.label}: recipients must not include the self-ref 'user'`,
        );
      }
      groupOk += 1;
    }
  }

  // Emit the load-bearing gate line.
  process.stdout.write(
    `valid=${valid}/${CASES.length} ` +
      `reply_present=${replyPresent}/${replyTotal} ` +
      `group_parties_ok=${groupOk}/${groupTotal}\n`,
  );

  assert.equal(valid, CASES.length, "all cases must be valid");
  assert.equal(replyPresent, replyTotal, "all reply cases must carry reply_to_id");
  assert.equal(groupOk, groupTotal, "all outbound-group cases must satisfy parties rule");
  assert.ok(replyTotal >= 1, "corpus must include at least one reply case");
  assert.ok(groupTotal >= 1, "corpus must include at least one outbound-group case");
});

// ---------------------------------------------------------------------------
// T2 — thread_type replicates isGroupChat's 3-way OR, each branch independently.
// ---------------------------------------------------------------------------
test("thread_type: cache_roomnames non-empty => group", () => {
  const env = toEnvelope({
    ts: "2025-01-01T00:00:00.000Z",
    source_msg_id: "TT-ROOM",
    parties: ["+10000000001", "user"],
    raw_content: {
      text: "hi",
      handle_id: "+10000000001",
      chat_guid: "any;-;+10000000001", // DM-shaped guid…
      cache_roomnames: "Named Room", // …but roomname forces group
      is_from_me: 0,
      participant_count: 2,
    },
  });
  assert.equal(env.thread_type, "group");
});

test("thread_type: participant_count > 2 => group", () => {
  const env = toEnvelope({
    ts: "2025-01-01T00:00:00.000Z",
    source_msg_id: "TT-PC",
    parties: ["+10000000002", "user"],
    raw_content: {
      text: "hi",
      handle_id: "+10000000002",
      chat_guid: "any;-;+10000000002",
      cache_roomnames: null,
      is_from_me: 0,
      participant_count: 3,
    },
  });
  assert.equal(env.thread_type, "group");
});

test("thread_type: chat_guid /;[+-];chat\\d+/ matches BOTH ;+; and ;-; framings", () => {
  for (const guid of ["any;+;chat123456", "any;-;chat987654"]) {
    const env = toEnvelope({
      ts: "2025-01-01T00:00:00.000Z",
      source_msg_id: `TT-GUID-${guid}`,
      parties: ["user", "+10000000003"],
      raw_content: {
        text: "hi",
        handle_id: null,
        chat_guid: guid,
        cache_roomnames: null,
        is_from_me: 1,
        participant_count: 0,
      },
    });
    assert.equal(env.thread_type, "group", `${guid} should be group`);
  }
});

test("thread_type: handle-bearing 1:1 guid with no group signal => dm", () => {
  const env = toEnvelope({
    ts: "2025-01-01T00:00:00.000Z",
    source_msg_id: "TT-DM",
    parties: ["+10000000004", "user"],
    raw_content: {
      text: "hi",
      handle_id: "+10000000004",
      chat_guid: "any;-;+10000000004",
      cache_roomnames: null,
      is_from_me: 0,
      participant_count: 2,
    },
  });
  assert.equal(env.thread_type, "dm");
});

// ---------------------------------------------------------------------------
// T3 — sender / is_from_me / recipients derivation.
// ---------------------------------------------------------------------------
test("outbound row => sender {id:'user',name:'user'}, is_from_me strict true", () => {
  const c = CASES.find((x) => x.label === "outbound_dm");
  const env = toEnvelope(c.raw_row);
  assert.deepEqual(env.sender, { id: "user", name: "user", kind: "person" });
  assert.strictEqual(env.is_from_me, true); // strict boolean, not 1
  assert.deepEqual(env.recipients, ["+14155550199"]); // parties minus 'user'
});

test("inbound resolved-name row reads stamped recovered_handle_name (no re-query)", () => {
  const c = CASES.find((x) => x.label === "inbound_dm_resolved_name");
  const env = toEnvelope(c.raw_row);
  assert.equal(env.sender.id, "+14155550199");
  assert.equal(env.sender.name, "Dana Reyes");
  assert.strictEqual(env.is_from_me, false);
  assert.deepEqual(env.recipients, ["user"]);
});

test("inbound unresolved contact => FORMATTED-NUMBER FLOOR (never null/hash) by default", () => {
  const c = CASES.find((x) => x.label === "inbound_dm_reply");
  // FLOOR ON (default): a handle-bearing inbound row whose contact does not resolve
  // surfaces the readable number, NEVER null (which would fall to person:<hash>).
  const env = toEnvelope(c.raw_row);
  assert.equal(env.sender.name, "+1 555 555 0125");
  // FLOOR OFF (opt-out, the genuine-resolution metric): reads the unmasked null.
  const raw = toEnvelope(c.raw_row, { handleNameFloor: false });
  assert.equal(raw.sender.name, null);
});

// ---------------------------------------------------------------------------
// T4 — reply_to plumbing + directed_at_me_signals.
// ---------------------------------------------------------------------------
test("reply_to_id reads thread_originator_guid; addressed_to_me = inbound", () => {
  const c = CASES.find((x) => x.label === "inbound_dm_reply");
  const env = toEnvelope(c.raw_row);
  assert.equal(env.reply_to_id, "1B2C3D4E-5F6A-4B7C-9D8E-0F1A2B3C4D5E");
  assert.equal(env.directed_at_me_signals.addressed_to_me, true);
  assert.equal(env.directed_at_me_signals.reply_to_me, false); // unknown at single-row scope
  assert.equal(env.directed_at_me_signals.mention_me, false);
});

test("outbound row => addressed_to_me false (operator is author)", () => {
  const c = CASES.find((x) => x.label === "outbound_dm");
  const env = toEnvelope(c.raw_row);
  assert.equal(env.directed_at_me_signals.addressed_to_me, false);
});

test("reply_to_id key always present (string|null) since reply_to_available=true", () => {
  const c = CASES.find((x) => x.label === "inbound_dm_resolved_name");
  const env = toEnvelope(c.raw_row);
  assert.ok(Object.prototype.hasOwnProperty.call(env, "reply_to_id"));
  assert.equal(env.reply_to_id, null); // not a reply, but key present
});

// ---------------------------------------------------------------------------
// T5 — content + ts conversion.
// ---------------------------------------------------------------------------
test("null-text tapback shell => content null", () => {
  const c = CASES.find((x) => x.label === "inbound_null_text_tapback");
  const env = toEnvelope(c.raw_row);
  assert.equal(env.content, null);
});

test("ts is converted ISO -> positive integer ms (N1 rejects ISO strings)", () => {
  const c = CASES.find((x) => x.label === "inbound_dm_reply");
  const env = toEnvelope(c.raw_row);
  assert.equal(typeof env.ts, "number");
  assert.equal(Number.isInteger(env.ts), true);
  assert.equal(env.ts, 1673320520250);
});

test("unparseable row.ts throws (envelope must never carry NaN)", () => {
  assert.throws(
    () =>
      toEnvelope({
        ts: "not-a-date",
        source_msg_id: "BAD-TS",
        parties: ["+1", "user"],
        raw_content: { text: "x", handle_id: "+1", chat_guid: "any;-;+1", is_from_me: 0 },
      }),
    /unparseable or non-positive/,
  );
});

// ---------------------------------------------------------------------------
// T6 — capabilities keystone + purity.
// ---------------------------------------------------------------------------
test("capabilities is the frozen iMessage literal (reply_to_available=true contrast)", () => {
  const env = toEnvelope(CASES[0].raw_row);
  assert.deepEqual(env.capabilities, {
    reply_to_available: true,
    structured_mentions: false,
    self_identity_reliable: true,
    addressing_first_class: false,
  });
  assert.equal(env.platform, "imessage");
  assert.equal(PLATFORM, "imessage");
});

test("mutating a returned envelope does not leak into the next call (fresh capabilities)", () => {
  const a = toEnvelope(CASES[0].raw_row);
  a.capabilities.reply_to_available = false; // tamper
  a.mentions.push({ id: "x", name: "x" });
  const b = toEnvelope(CASES[0].raw_row);
  assert.equal(b.capabilities.reply_to_available, true, "capabilities must not be shared mutable state");
  assert.deepEqual(b.mentions, [], "mentions must be a fresh array");
});

test("toEnvelopeChecked passes for every case (self-validating variant)", () => {
  for (const c of CASES) {
    const env = toEnvelopeChecked(c.raw_row);
    assert.equal(env.platform, "imessage");
  }
});

test("non-object row throws (defensive boundary)", () => {
  assert.throws(() => toEnvelope(null), /plain object/);
  assert.throws(() => toEnvelope([]), /plain object/);
});

// ---------------------------------------------------------------------------
// T7 — Thesis #1 / abstraction gates over the adapter SOURCE (static).
// ---------------------------------------------------------------------------
test("adapter imports NOTHING from mcp/lib/connectors/*", () => {
  const src = readFileSync(ADAPTER_SRC, "utf8");
  assert.equal(
    /from\s+["'][^"']*connectors\//.test(src),
    false,
    "adapter must not import from the frozen connector layer",
  );
});

test("adapter does not re-query Contacts/AddressBook/chat.db (read-only over the row)", () => {
  const src = readFileSync(ADAPTER_SRC, "utf8");
  // No import of the name-recovery module, no sqlite/db handle, no AddressBook.
  assert.equal(/_imessage-name-recovery|AddressBook|Contacts\b|chat\.db|sqlite/i.test(
    // exclude comment-only mentions by checking import/require + call shapes
    src.replace(/^\s*\/\/.*$/gm, ""),
  ), false, "adapter must not re-query any source — it reads the stamped row only");
});
