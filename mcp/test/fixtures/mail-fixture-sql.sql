-- mail-fixture-sql.sql — synthetic Apple Mail Envelope Index for hermetic tests.
--
-- Minimal subset of the macOS Mail.app Envelope Index schema:
--   messages, addresses, subjects, mailboxes
-- Only the columns the mail connector reads are present. All addresses are
-- synthetic placeholders (alice@example.com, bob@example.com, etc.) — NEVER
-- real contact emails. Bodies live as .emlx files at
-- mcp/test/fixtures/mail-fixture-bodies/msg-<N>.emlx; the test harness
-- overrides bodyResolver to map document_id -> the fixture path.
--
-- The nineteen fixture rows:
--   ROWID 1: newsletter with List-Unsubscribe header → Stage-0 DROP
--   ROWID 2: 1:1 personal email (operator as sole To:) → second_party_dm
--   ROWID 3: marketing email (mailchimp Return-Path) → Stage-0 DROP
--   ROWID 4: reply with quoted thread → operator-new text only
--   ROWID 5: email with RFC 3676 signature → signature stripped
--   ROWID 6: outbound email from operator (alex@example.com) → first_party
--   ROWID 7: Auto-Submitted: auto-replied → Stage-0 DROP (auto_submitted)
--   ROWID 8: Precedence: bulk → Stage-0 DROP (bulk_precedence)
--   ROWID 9: List-Id only (no List-Unsubscribe) → Stage-0 DROP (list_id)
--   ROWID 10: Apple automated_conversation=1 → Stage-0 DROP (apple_automated)
--   ROWID 11: noreply@ From: sender → Stage-0 DROP (noreply_sender)
--   ROWID 12: OTP / verification code body → Stage-0 REDACT_DROP (otp_pattern)
--   ROWID 13: sendgrid Return-Path → Stage-0 DROP (marketing_platform)
--   ROWID 14: multipart/calendar invite (empty body) → Stage-0 DROP (placeholder_residual)
--   ROWID 15: list_id_hash >= 2^53 (L29 unsafe-INTEGER row) → poll must not
--             throw ERR_OUT_OF_RANGE; Stage-0 DROP (list_id)
--   ROWID 16: PRODUCTION-SHAPED — document_id NULL (277,815/277,920 real
--             rows); source_msg_id falls back to 'rowid:16'; default body
--             resolver finds on-disk 16.emlx by ROWID basename (T20)
--   ROWID 17: PRODUCTION-SHAPED — document_id is a binary BLOB (105/277,920
--             real rows carry a 16-byte BLOB, never a filename); behaves
--             exactly like NULL; only 17.partial.emlx on disk (T20)
--   ROWID 18: PRODUCTION-SHAPED — document_id NULL with NO on-disk body
--             file; body_resolved must stay honestly false, row still
--             appends with JOIN-synthesized From (T20)
--   ROWID 19: THREAD REPLY — carries Message-ID + In-Reply-To + a two-id
--             References chain (root then immediate parent), so the
--             root-vs-parent distinction in the References bound is
--             testable (T22)

PRAGMA journal_mode = WAL;

CREATE TABLE addresses (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT COLLATE NOCASE NOT NULL,
  comment TEXT COLLATE BINARY NOT NULL DEFAULT '',
  UNIQUE(address, comment) ON CONFLICT IGNORE
);

CREATE TABLE subjects (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT COLLATE RTRIM NOT NULL,
  UNIQUE(subject) ON CONFLICT IGNORE
);

CREATE TABLE mailboxes (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT COLLATE BINARY NOT NULL DEFAULT '',
  total_count INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER NOT NULL DEFAULT 0,
  deleted_count INTEGER NOT NULL DEFAULT 0,
  unseen_count INTEGER NOT NULL DEFAULT 0,
  unread_count_adjusted_for_duplicates INTEGER NOT NULL DEFAULT 0,
  source INTEGER
);

CREATE TABLE messages (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL DEFAULT 0,
  global_message_id INTEGER NOT NULL DEFAULT 0,
  remote_id INTEGER,
  document_id TEXT COLLATE BINARY,
  sender INTEGER,
  subject INTEGER,
  date_received INTEGER,
  date_sent INTEGER,
  mailbox INTEGER NOT NULL DEFAULT 1,
  flags INTEGER NOT NULL DEFAULT 0,
  read INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  list_id_hash INTEGER,
  unsubscribe_type INTEGER,
  automated_conversation INTEGER DEFAULT 0,
  brand_indicator INTEGER,
  conversation_id INTEGER NOT NULL DEFAULT 0
);

-- Mailbox: a single Inbox.
INSERT INTO mailboxes (ROWID, url) VALUES (1, 'imap://alex@example.com/INBOX');

-- Addresses + subjects.
INSERT INTO addresses (ROWID, address, comment) VALUES (1, 'newsletter@example.com', 'Example Newsletter');
INSERT INTO addresses (ROWID, address, comment) VALUES (2, 'alice@example.com', 'Alice Example');
INSERT INTO addresses (ROWID, address, comment) VALUES (3, 'sales@example-store.example', 'Example Store');
INSERT INTO addresses (ROWID, address, comment) VALUES (4, 'bob@example.com', 'Bob Example');
INSERT INTO addresses (ROWID, address, comment) VALUES (5, 'charlie@example.com', 'Charlie Example');
INSERT INTO addresses (ROWID, address, comment) VALUES (6, 'alex@example.com', 'Operator');
INSERT INTO addresses (ROWID, address, comment) VALUES (7, 'alice@example.com', 'Alice Example (auto-reply)');
INSERT INTO addresses (ROWID, address, comment) VALUES (8, 'bulk@example.com', 'Bulk Sender');
INSERT INTO addresses (ROWID, address, comment) VALUES (9, 'member@example.com', 'Discussion Member');
INSERT INTO addresses (ROWID, address, comment) VALUES (10, 'notifications@example.com', 'Workflow Notifications');
INSERT INTO addresses (ROWID, address, comment) VALUES (11, 'noreply@synth.example.com', 'System');
INSERT INTO addresses (ROWID, address, comment) VALUES (12, 'verify@synth.example.com', 'Verify Service');
INSERT INTO addresses (ROWID, address, comment) VALUES (13, 'promo@example-shop.example', 'Promo Sender');
INSERT INTO addresses (ROWID, address, comment) VALUES (14, 'invites@example.com', 'Calendar Service');
INSERT INTO addresses (ROWID, address, comment) VALUES (15, 'digest@example.com', 'Big Hash List');
INSERT INTO addresses (ROWID, address, comment) VALUES (16, 'dana@example.com', 'Dana Example');
INSERT INTO addresses (ROWID, address, comment) VALUES (17, 'evan@example.com', 'Evan Example');
INSERT INTO addresses (ROWID, address, comment) VALUES (18, 'orphan@example.com', 'Orphan Envelope');

INSERT INTO subjects (ROWID, subject) VALUES (1, 'Weekly Newsletter');
INSERT INTO subjects (ROWID, subject) VALUES (2, 'Coffee plans for tomorrow');
INSERT INTO subjects (ROWID, subject) VALUES (3, 'Spring sale - 50 percent off');
INSERT INTO subjects (ROWID, subject) VALUES (4, 'Re: design review');
INSERT INTO subjects (ROWID, subject) VALUES (5, 'Question about the project');
INSERT INTO subjects (ROWID, subject) VALUES (6, 'Trip itinerary');
INSERT INTO subjects (ROWID, subject) VALUES (7, 'Out of office: vacation responder');
INSERT INTO subjects (ROWID, subject) VALUES (8, 'Community digest for this week');
INSERT INTO subjects (ROWID, subject) VALUES (9, 'Re: thread topic');
INSERT INTO subjects (ROWID, subject) VALUES (10, 'Workflow notification: step complete');
INSERT INTO subjects (ROWID, subject) VALUES (11, 'Account notice');
INSERT INTO subjects (ROWID, subject) VALUES (12, 'Sign-in code');
INSERT INTO subjects (ROWID, subject) VALUES (13, 'Summer collection preview');
INSERT INTO subjects (ROWID, subject) VALUES (14, 'Meeting invitation');
INSERT INTO subjects (ROWID, subject) VALUES (15, 'Digest with a 64-bit list hash');
INSERT INTO subjects (ROWID, subject) VALUES (16, 'Production-shaped NULL document id');
INSERT INTO subjects (ROWID, subject) VALUES (17, 'Production-shaped BLOB document id');
INSERT INTO subjects (ROWID, subject) VALUES (18, 'Orphan envelope with no body file');
INSERT INTO subjects (ROWID, subject) VALUES (19, 'Re: quarterly planning thread');

-- ROWID 1: newsletter — Stage-0 drop via Apple unsubscribe_type signal.
INSERT INTO messages (
  ROWID, document_id, sender, subject, date_received, list_id_hash,
  unsubscribe_type, automated_conversation, brand_indicator, mailbox, deleted
) VALUES (
  1, 'msg-1', 1, 1, 1780000000, 12345, 1, 0, 7, 1, 0
);

-- ROWID 2: 1:1 personal email — alice -> operator.
INSERT INTO messages (
  ROWID, document_id, sender, subject, date_received, list_id_hash,
  unsubscribe_type, automated_conversation, brand_indicator, mailbox, deleted
) VALUES (
  2, 'msg-2', 2, 2, 1780001000, NULL, 0, 0, NULL, 1, 0
);

-- ROWID 3: marketing email — Apple did not flag it, but Return-Path matches
-- mailchimp.com → Stage-0 marketing_platform DROP via RFC headers.
INSERT INTO messages (
  ROWID, document_id, sender, subject, date_received, list_id_hash,
  unsubscribe_type, automated_conversation, brand_indicator, mailbox, deleted
) VALUES (
  3, 'msg-3', 3, 3, 1780002000, NULL, 0, 0, NULL, 1, 0
);

-- ROWID 4: legitimate reply with quoted thread — operator-new text only.
INSERT INTO messages (
  ROWID, document_id, sender, subject, date_received, list_id_hash,
  unsubscribe_type, automated_conversation, brand_indicator, mailbox, deleted
) VALUES (
  4, 'msg-4', 4, 4, 1780003000, NULL, 0, 0, NULL, 1, 0
);

-- ROWID 5: email with RFC 3676 signature.
INSERT INTO messages (
  ROWID, document_id, sender, subject, date_received, list_id_hash,
  unsubscribe_type, automated_conversation, brand_indicator, mailbox, deleted
) VALUES (
  5, 'msg-5', 5, 5, 1780004000, NULL, 0, 0, NULL, 1, 0
);

-- ROWID 6: outbound email from operator (alex@example.com) → first_party.
INSERT INTO messages (
  ROWID, document_id, sender, subject, date_received, list_id_hash,
  unsubscribe_type, automated_conversation, brand_indicator, mailbox, deleted
) VALUES (
  6, 'msg-6', 6, 6, 1780005000, NULL, 0, 0, NULL, 1, 0
);

-- ROWID 7: Auto-Submitted: auto-replied (vacation responder) → Stage-0 DROP.
-- No Apple-side flags; the auto_submitted detection lives entirely in the
-- RFC header path. Apple-derived columns are zero/null.
INSERT INTO messages (
  ROWID, document_id, sender, subject, date_received, list_id_hash,
  unsubscribe_type, automated_conversation, brand_indicator, mailbox, deleted
) VALUES (
  7, 'msg-7', 7, 7, 1780006000, NULL, 0, 0, NULL, 1, 0
);

-- ROWID 8: Precedence: bulk (list-bulk mailing) → Stage-0 DROP.
INSERT INTO messages (
  ROWID, document_id, sender, subject, date_received, list_id_hash,
  unsubscribe_type, automated_conversation, brand_indicator, mailbox, deleted
) VALUES (
  8, 'msg-8', 8, 8, 1780007000, NULL, 0, 0, NULL, 1, 0
);

-- ROWID 9: List-Id only (no List-Unsubscribe; pure RFC mailing list) →
-- Stage-0 DROP. Apple's list_id_hash column intentionally NULL so this
-- exercises the headers["list-id"] code path, not the Apple shortcut.
INSERT INTO messages (
  ROWID, document_id, sender, subject, date_received, list_id_hash,
  unsubscribe_type, automated_conversation, brand_indicator, mailbox, deleted
) VALUES (
  9, 'msg-9', 9, 9, 1780008000, NULL, 0, 0, NULL, 1, 0
);

-- ROWID 10: Apple automated_conversation flag set (workflow notification).
-- No RFC marker; the drop is driven by the Apple integer column only, so
-- this exercises the automated_conversation > 0 branch in priority order
-- (rule 9).
INSERT INTO messages (
  ROWID, document_id, sender, subject, date_received, list_id_hash,
  unsubscribe_type, automated_conversation, brand_indicator, mailbox, deleted
) VALUES (
  10, 'msg-10', 10, 10, 1780009000, NULL, 0, 1, NULL, 1, 0
);

-- ROWID 11: noreply@ From: sender → Stage-0 DROP (noreply_sender).
INSERT INTO messages (
  ROWID, document_id, sender, subject, date_received, list_id_hash,
  unsubscribe_type, automated_conversation, brand_indicator, mailbox, deleted
) VALUES (
  11, 'msg-11', 11, 11, 1780010000, NULL, 0, 0, NULL, 1, 0
);

-- ROWID 12: OTP / verification code in body → Stage-0 REDACT_DROP.
-- Body says "Your sign-in verification code is 654321." which matches
-- SALIENCE_OTP_REGEX. The 654321 code is fictional.
INSERT INTO messages (
  ROWID, document_id, sender, subject, date_received, list_id_hash,
  unsubscribe_type, automated_conversation, brand_indicator, mailbox, deleted
) VALUES (
  12, 'msg-12', 12, 12, 1780011000, NULL, 0, 0, NULL, 1, 0
);

-- ROWID 13: sendgrid Return-Path → Stage-0 DROP (marketing_platform).
-- Second marketing platform after mailchimp (msg-3).
INSERT INTO messages (
  ROWID, document_id, sender, subject, date_received, list_id_hash,
  unsubscribe_type, automated_conversation, brand_indicator, mailbox, deleted
) VALUES (
  13, 'msg-13', 13, 13, 1780012000, NULL, 0, 0, NULL, 1, 0
);

-- ROWID 14: multipart/calendar invite (no text/plain or text/html part) →
-- empty body extraction → Stage-0 DROP (placeholder_residual) via the
-- text.trim().length<2 rule. Calendar invite routing is deferred to a
-- future ingest layer; for now Stage-0 catches it as a residual.
INSERT INTO messages (
  ROWID, document_id, sender, subject, date_received, list_id_hash,
  unsubscribe_type, automated_conversation, brand_indicator, mailbox, deleted
) VALUES (
  14, 'msg-14', 14, 14, 1780013000, NULL, 0, 0, NULL, 1, 0
);

-- ROWID 15: L29 unsafe-INTEGER coverage. list_id_hash carries a value
-- >= 2^53 (1234567890123456789 — an invented value that is unsafe as a
-- JS number). Pre-L30-fix, node:sqlite's stmt.all() threw
-- ERR_OUT_OF_RANGE on this row and the whole batch failed; with the
-- CAST(... AS TEXT) in the connector's SELECT the row must land and
-- Stage-0 must DROP it via Rule 2 (list_id). No .emlx body on purpose —
-- the orphan-envelope path synthesizes From: from the addresses JOIN.
INSERT INTO messages (
  ROWID, document_id, sender, subject, date_received, list_id_hash,
  unsubscribe_type, automated_conversation, brand_indicator, mailbox, deleted
) VALUES (
  15, 'msg-15', 15, 15, 1780014000, 1234567890123456789, 0, 0, NULL, 1, 0
);

-- ROWID 16: PRODUCTION-SHAPED — document_id NULL. In the real Envelope
-- Index 277,815/277,920 rows have NULL document_id (verified read-only
-- 2026-07-10), so the connector's 'rowid:<n>' fallback is the norm, not the
-- exception. T20 pairs this row with an on-disk 16.emlx (basename ==
-- ROWID) that defaultBodyResolver must find without an injected resolver.
INSERT INTO messages (
  ROWID, document_id, sender, subject, date_received, list_id_hash,
  unsubscribe_type, automated_conversation, brand_indicator, mailbox, deleted
) VALUES (
  16, NULL, 16, 16, 1780015000, NULL, 0, 0, NULL, 1, 0
);

-- ROWID 17: PRODUCTION-SHAPED — document_id is a binary BLOB. The 105
-- non-NULL rows in the real Envelope Index carry a 16-byte binary BLOB
-- (never a filename); typeof !== "string" so the connector must take the
-- same 'rowid:<n>' fallback as NULL. T20 pairs this row with ONLY a
-- 17.partial.emlx on disk to exercise the .partial.emlx candidate.
INSERT INTO messages (
  ROWID, document_id, sender, subject, date_received, list_id_hash,
  unsubscribe_type, automated_conversation, brand_indicator, mailbox, deleted
) VALUES (
  17, X'DEADBEEF', 17, 17, 1780016000, NULL, 0, 0, NULL, 1, 0
);

-- ROWID 18: PRODUCTION-SHAPED — document_id NULL and NO on-disk body file.
-- body_resolved must stay honestly false; the row still appends with a
-- From: synthesized from the addresses JOIN (orphan-envelope path).
INSERT INTO messages (
  ROWID, document_id, sender, subject, date_received, list_id_hash,
  unsubscribe_type, automated_conversation, brand_indicator, mailbox, deleted
) VALUES (
  18, NULL, 18, 18, 1780017000, NULL, 0, 0, NULL, 1, 0
);

-- ROWID 19: THREAD REPLY — a body-resolved human reply whose .emlx carries
-- Message-ID, In-Reply-To and a FOLDED two-id References chain
-- (<msg-19-root@...> then <msg-19-parent@...>). The connector must surface
-- both reply headers on raw_content.headers alongside the message-id it
-- already surfaces; the two-id chain makes root-vs-parent distinguishable so
-- the adapter's _threadId (refs[0]) and _replyToId (refs[last]) are both
-- exercisable. Sender reuses address 16 (dana@example.com).
INSERT INTO messages (
  ROWID, document_id, sender, subject, date_received, list_id_hash,
  unsubscribe_type, automated_conversation, brand_indicator, mailbox, deleted
) VALUES (
  19, 'msg-19', 16, 19, 1780018000, NULL, 0, 0, NULL, 1, 0
);

-- ---------------------------------------------------------------------------
-- RECIPIENT RECOVERY fixture (mirrors Apple Mail's real Envelope Index).
--
-- Sent mail almost never has a resolvable .emlx body, so To:/Cc: cannot come
-- from the parsed headers — measured on the real store, 2,728 of 2,744
-- operator-authored rows had body_resolved=false, leaving the outbound half of
-- the correspondence graph empty (0.5% of sent rows carried any counterparty).
-- The envelope DB knows recipients independently of the body via this table.
--
-- Kept as a SEPARATE table so the connector's capability probe is exercised
-- both ways: fixtures that omit it must still poll normally.
--   type 0 = To, type 1 = Cc  (Apple's encoding)
-- ROWID 18 is the orphan-envelope row: no .emlx body at all, so From: is
-- already synthesised from the addresses JOIN. Its To:/Cc: are the other half
-- of that same gap and are what this table restores.
-- ---------------------------------------------------------------------------
CREATE TABLE recipients (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
  message INTEGER,
  address INTEGER,
  type INTEGER,
  position INTEGER
);
INSERT INTO recipients (message, address, type, position) VALUES (18, 2, 0, 0);
INSERT INTO recipients (message, address, type, position) VALUES (18, 4, 1, 1);
