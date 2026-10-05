-- imessage-fixture.sql — synthetic Apple chat.db for hermetic connector tests.
--
-- Schema is a minimal subset of macOS Ventura+ chat.db (Messages.app):
--   message, handle, chat, chat_handle_join, chat_message_join
-- Only the columns the iMessage connector reads are present. We rely on
-- node:sqlite's permissive typing — BLOB columns hold raw bytes via Buffer
-- when inserted via prepared statements; this script seeds only NULLable
-- text + the integer columns the connector classifier needs.
--
-- The connector reads attributedBody as a Uint8Array; this fixture does NOT
-- exercise attributedBody decode (that lives in a separate decoder unit
-- test that passes a hand-crafted buffer directly to decodeAttributedBody).
-- All fixture rows have non-null message.text so the classifier path is
-- the test focus.
--
-- The seven test edge cases — one row each:
--   ROWID 1: outbound to a 1:1 handle      → first_party
--   ROWID 2: inbound from a 1:1 handle     → second_party_dm
--   ROWID 3: inbound to a 3-person group   → third_party_inferred (cache_roomnames set)
--   ROWID 4: inbound from a business handle (handle.id BIZ:42)
--                                          → third_party_inferred
--   ROWID 5: tapback (associated_message_type=2000) referencing ROWID-2's guid
--                                          → kind=reaction, derived_from=[guid-of-2]
--   ROWID 6: reply (thread_originator_guid set) — same room as ROWID 1
--            (1:1) outbound                → first_party with in_reply_to set
--   ROWID 7: inbound 1:1 with text=NULL but attributedBody present (decode
--            failure path — test loads a junk blob so decode_error=true)
--
-- Apple's date column: Ventura+ stores ns since Mac epoch. Use a 2026-06-02
-- representative value for all rows; the exact value is not part of any
-- classification test, but the connector converts to ISO ts.

PRAGMA journal_mode = WAL;

CREATE TABLE handle (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT,
  service TEXT
);

CREATE TABLE chat (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
  guid TEXT,
  -- Tahoe (macOS 26+) renamed cache_roomnames to room_name with identical
  -- semantics. The connector reads c.room_name AS cache_roomnames. Fixture
  -- carries BOTH columns (cache_roomnames for legacy reference, room_name
  -- for the connector's actual read). At INSERT time we set them to the
  -- same value so test expectations against either column hold.
  cache_roomnames TEXT,
  room_name TEXT
);

CREATE TABLE chat_handle_join (
  chat_id INTEGER,
  handle_id INTEGER,
  PRIMARY KEY (chat_id, handle_id)
);

CREATE TABLE message (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
  guid TEXT,
  text TEXT,
  attributedBody BLOB,
  is_from_me INTEGER,
  associated_message_type INTEGER DEFAULT 0,
  associated_message_guid TEXT,
  thread_originator_guid TEXT,
  date INTEGER,
  service TEXT,
  handle_id INTEGER
);

CREATE TABLE chat_message_join (
  chat_id INTEGER,
  message_id INTEGER,
  PRIMARY KEY (chat_id, message_id)
);

-- ---------------------------------------------------------------------------
-- Handles
-- ---------------------------------------------------------------------------
-- handle 1: a normal phone-number contact
INSERT INTO handle (ROWID, id, service) VALUES (1, '+15551234567', 'iMessage');
-- handle 2: a second contact (used in the group chat)
INSERT INTO handle (ROWID, id, service) VALUES (2, '+15559876543', 'iMessage');
-- handle 3: a third contact (used in the group chat)
INSERT INTO handle (ROWID, id, service) VALUES (3, 'friend@example.com', 'iMessage');
-- handle 4: a business iMessage merchant
INSERT INTO handle (ROWID, id, service) VALUES (4, 'BIZ:42', 'BusinessChat');
-- handle 5: an RCS contact (Phase A1 CRIT-C — real handle service mix on the
-- operator's machine is 953 SMS / 419 RCS / 165 iMessage / 0 BusinessChat /
-- 0 BIZ:). The fixture had only iMessage + BusinessChat handles so the RCS
-- path was untested. RCS classifier behavior is identical to iMessage for
-- consent purposes (1:1 inbound is second_party_dm).
INSERT INTO handle (ROWID, id, service) VALUES (5, '+15554443333', 'RCS');
-- handle 6 (R27 HIGH-E): a BusinessChat merchant where handle.id is the bare
-- email/URI form (NO `BIZ:` prefix). On the operator's real machine 0 handles
-- match /^BIZ:/, so the regex branch in classifyRow is dead-code; the OR
-- branch (service === 'BusinessChat') is what actually identifies business
-- merchants. This fixture row proves the service-only signal is sufficient.
INSERT INTO handle (ROWID, id, service) VALUES (6, 'applepay@business.apple', 'BusinessChat');

-- ---------------------------------------------------------------------------
-- Chats
-- ---------------------------------------------------------------------------
-- chat 1: 1:1 with handle 1
INSERT INTO chat (ROWID, guid, cache_roomnames, room_name) VALUES (1, 'iMessage;-;+15551234567', NULL, NULL);
INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1, 1);

-- chat 2: 3-person group with handles 1, 2, 3 (cache_roomnames set)
INSERT INTO chat (ROWID, guid, cache_roomnames, room_name) VALUES (2, 'iMessage;+;chat0001', 'weekend-trip', 'weekend-trip');
INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (2, 1);
INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (2, 2);
INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (2, 3);

-- chat 3: 1:1 with the business handle
INSERT INTO chat (ROWID, guid, cache_roomnames, room_name) VALUES (3, 'BusinessChat;-;BIZ:42', NULL, NULL);
INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (3, 4);

-- chat 4: 3-person group with cache_roomnames=NULL AND room_name=NULL (Phase
-- A1 HIGH-H — Rule 3 boundary case. 16 real chats have partn=2 (operator +
-- 2 others = 3 person group). Classifier must take the third_party_inferred
-- path via participant_count > 2 alone, not via the room_name signal.
INSERT INTO chat (ROWID, guid, cache_roomnames, room_name) VALUES (4, 'iMessage;+;chat0002', NULL, NULL);
INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (4, 2);
INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (4, 3);

-- chat 5: 1:1 with the RCS handle (Phase A1 CRIT-C).
INSERT INTO chat (ROWID, guid, cache_roomnames, room_name) VALUES (5, 'RCS;-;+15554443333', NULL, NULL);
INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (5, 5);

-- chat 6 (R27 HIGH-E): 1:1 with the BusinessChat-without-BIZ-prefix handle.
INSERT INTO chat (ROWID, guid, cache_roomnames, room_name) VALUES (6, 'BusinessChat;-;applepay@business.apple', NULL, NULL);
INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (6, 6);

-- ---------------------------------------------------------------------------
-- Messages
-- ---------------------------------------------------------------------------
-- ROWID 1: outbound 1:1 to handle 1 → first_party
INSERT INTO message (ROWID, guid, text, is_from_me, associated_message_type, date, service, handle_id)
VALUES (1, 'guid-msg-1', 'hello from me (outbound 1:1)', 1, 0, 770000000000000000, 'iMessage', 0);
INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1);

-- ROWID 2: inbound 1:1 from handle 1 → second_party_dm
INSERT INTO message (ROWID, guid, text, is_from_me, associated_message_type, date, service, handle_id)
VALUES (2, 'guid-msg-2', 'hi back (inbound 1:1)', 0, 0, 770000060000000000, 'iMessage', 1);
INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 2);

-- ROWID 3: inbound from handle 2 to the 3-person group → third_party_inferred
INSERT INTO message (ROWID, guid, text, is_from_me, associated_message_type, date, service, handle_id)
VALUES (3, 'guid-msg-3', 'who is bringing snacks (inbound group)', 0, 0, 770000120000000000, 'iMessage', 2);
INSERT INTO chat_message_join (chat_id, message_id) VALUES (2, 3);

-- ROWID 4: inbound from business handle → third_party_inferred
INSERT INTO message (ROWID, guid, text, is_from_me, associated_message_type, date, service, handle_id)
VALUES (4, 'guid-msg-4', 'Your order has shipped (business iMessage)', 0, 0, 770000180000000000, 'BusinessChat', 4);
INSERT INTO chat_message_join (chat_id, message_id) VALUES (3, 4);

-- ROWID 5: outbound tapback (Love=2000) referencing ROWID 2's guid
INSERT INTO message (ROWID, guid, text, is_from_me, associated_message_type, associated_message_guid, date, service, handle_id)
VALUES (5, 'guid-msg-5', NULL, 1, 2000, 'guid-msg-2', 770000240000000000, 'iMessage', 0);
INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 5);

-- ROWID 6: outbound reply (thread_originator_guid set) in the 1:1 → first_party
INSERT INTO message (ROWID, guid, text, is_from_me, associated_message_type, thread_originator_guid, date, service, handle_id)
VALUES (6, 'guid-msg-6', 'replying to your earlier message', 1, 0, 'guid-msg-2', 770000300000000000, 'iMessage', 0);
INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 6);

-- ---------------------------------------------------------------------------
-- attributedBody-only rows (source-fidelity round; spec § 2).
--
-- macOS Ventura+ stores the canonical message text in
-- message.attributedBody as an NSKeyedArchiver typedstream blob whenever
-- the legacy m.text column would be a placeholder (U+FFFC Object
-- Replacement Character) or NULL. These three rows exercise the
-- parseTypedstream decoder path:
--
-- ROWID 7: inbound 1:1 from handle 1; m.text=NULL; attributedBody holds the
--          synthetic typedstream encoding of:
--          "the sample contact is Robin; they work in Dayton"
-- ROWID 8: outbound 1:1 to handle 1; m.text=NULL; attributedBody holds the
--          synthetic typedstream encoding of:
--          "outbound test message from user partner via attributedBody"
-- ROWID 9: inbound 1:1 from handle 1; m.text='legacy fallback text'; the
--          attributedBody is deliberately corrupt (declared length runs
--          past buffer end). Decoder returns null; connector falls back
--          to m.text and sets attributedBody_decode_error=true.
--
-- The X'...' blob literals were produced by
-- mcp/test/fixtures/_typedstream-fixture-builder.mjs and inlined here so
-- npm test does not depend on Node-side blob building at SQL-load time.
-- ---------------------------------------------------------------------------

-- ROWID 7: inbound 1:1 with attributedBody-only payload (decoder success path).
--   Plaintext: "the sample contact is Robin; they work in Dayton" (48 bytes)
INSERT INTO message (ROWID, guid, text, attributedBody, is_from_me, associated_message_type, date, service, handle_id)
VALUES (7, 'guid-msg-7', NULL,
  X'040b73747265616d747970656481e803840140848484194e534d757461626c6541747472696275746564537472696e67008484124e5341747472696275746564537472696e67008484084e534f626a6563740085928484840f4e534d757461626c65537472696e67018484084e53537472696e67019584012b307468652073616d706c6520636f6e7461637420697320526f62696e3b207468657920776f726b20696e20446179746f6e8684',
  0, 0, 770000360000000000, 'iMessage', 1);
INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 7);

-- ROWID 8: outbound 1:1 with attributedBody-only payload (decoder success path).
--   Plaintext: "outbound test message from user partner via attributedBody" (58 bytes)
INSERT INTO message (ROWID, guid, text, attributedBody, is_from_me, associated_message_type, date, service, handle_id)
VALUES (8, 'guid-msg-8', NULL,
  X'040b73747265616d747970656481e803840140848484194e534d757461626c6541747472696275746564537472696e67008484124e5341747472696275746564537472696e67008484084e534f626a6563740085928484840f4e534d757461626c65537472696e67018484084e53537472696e67019584012b3a6f7574626f756e642074657374206d6573736167652066726f6d207573657220706172746e6572207669612061747472696275746564426f64798684',
  1, 0, 770000420000000000, 'iMessage', 0);
INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 8);

-- ROWID 9: inbound 1:1 with CORRUPT attributedBody; legacy text present.
--   Decoder must return null; raw_content.text falls back to m.text and
--   raw_content.attributedBody_decode_error === true.
INSERT INTO message (ROWID, guid, text, attributedBody, is_from_me, associated_message_type, date, service, handle_id)
VALUES (9, 'guid-msg-9', 'legacy fallback text',
  X'040b73747265616d747970656481e803840140848484194e534d757461626c6541747472696275746564537472696e67008484124e5341747472696275746564537472696e67008484084e534f626a6563740085928484840f4e534d757461626c65537472696e67018484084e53537472696e67019584012b81ffff41424344',
  0, 0, 770000480000000000, 'iMessage', 1);
INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 9);

-- ---------------------------------------------------------------------------
-- R23 (Phase A1) fixture rows: production-edge values that the original
-- fixture sanitized out. These exercise the bug class CRIT-1 was an instance
-- of: fixture happy-path values hiding production extremes.
-- ---------------------------------------------------------------------------

-- ROWID 10 (CRIT-A): message.date exceeding Number.MAX_SAFE_INTEGER. Real
-- chat.db stores carry nanosecond m.date values near 8.0e17, well over 2^53;
-- the value below is an invented one. The connector CAST's m.date AS TEXT and uses a
-- BigInt path in macEpochNsToIso to preserve ms precision. Test asserts the
-- ISO string parses to a 2026-era date.
INSERT INTO message (ROWID, guid, text, is_from_me, associated_message_type, date, service, handle_id)
VALUES (10, 'guid-msg-10', 'huge-date row', 1, 0, 800000000123000000, 'iMessage', 0);
INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 10);

-- ROWID 11 (CRIT-B): both text=NULL AND attributedBody=NULL. 266/15157 rows
-- (1.75%) of real chat.db match this shape (status/system messages, certain
-- tapback shells). Connector must still emit the row with text=null and
-- text_source=null; no error.
INSERT INTO message (ROWID, guid, text, attributedBody, is_from_me, associated_message_type, date, service, handle_id)
VALUES (11, 'guid-msg-11', NULL, NULL, 0, 0, 770000540000000000, 'iMessage', 1);
INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 11);

-- ROWID 12 (CRIT-C): inbound 1:1 RCS. Real handle service mix has 419 RCS
-- messages, all currently untested. RCS classifier behavior matches iMessage:
-- 1:1 inbound is second_party_dm.
INSERT INTO message (ROWID, guid, text, is_from_me, associated_message_type, date, service, handle_id)
VALUES (12, 'guid-msg-12', 'rcs message from a phone-number contact', 0, 0, 770000600000000000, 'RCS', 5);
INSERT INTO chat_message_join (chat_id, message_id) VALUES (5, 12);

-- ROWID 13 (HIGH-H): inbound 3-person group with NO room name. 16 real chats
-- match this shape. Classifier must use participant_count > 2 alone to land
-- on third_party_inferred.
INSERT INTO message (ROWID, guid, text, is_from_me, associated_message_type, date, service, handle_id)
VALUES (13, 'guid-msg-13', 'unnamed group of three', 0, 0, 770000660000000000, 'iMessage', 2);
INSERT INTO chat_message_join (chat_id, message_id) VALUES (4, 13);

-- ROWID 14 (HIGH-I): U+FFFC (Object Replacement Character) text with CORRUPT
-- attributedBody. Real chat.db has 2 such rows. Connector must scrub the
-- placeholder to text=null (rather than emitting U+FFFC which would pollute
-- salience) and stamp attributedBody_decode_error=true. Note: SQLite's
-- char(65532) emits the Unicode codepoint U+FFFC.
INSERT INTO message (ROWID, guid, text, attributedBody, is_from_me, associated_message_type, date, service, handle_id)
VALUES (14, 'guid-msg-14', char(65532),
  X'040b73747265616d747970656481e803840140848484194e534d757461626c6541747472696275746564537472696e67008484124e5341747472696275746564537472696e67008484084e534f626a6563740085928484840f4e534d757461626c65537472696e67018484084e53537472696e67019584012b81ffff41424344',
  0, 0, 770000720000000000, 'iMessage', 1);
INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 14);

-- ROWID 15 (R27 HIGH-E): inbound 1:1 from the BusinessChat merchant whose
-- handle.id has NO `BIZ:` prefix. Real chat.db on the operator's machine has
-- zero `BIZ:%` handles; classifyRow's /^BIZ:/ regex never fires in production.
-- The connector must still mark this row third_party_inferred via the
-- service==='BusinessChat' OR branch. If that branch were dropped, every
-- production business-merchant row would silently mis-classify as
-- second_party_dm (Rule 2) — a per-row consent regression.
INSERT INTO message (ROWID, guid, text, is_from_me, associated_message_type, date, service, handle_id)
VALUES (15, 'guid-msg-15', 'Your Apple Pay receipt is ready', 0, 0, 770000780000000000, 'BusinessChat', 6);
INSERT INTO chat_message_join (chat_id, message_id) VALUES (6, 15);
