-- whatsapp-fixture.sql — synthetic WhatsApp ChatStorage.sqlite for hermetic
-- connector tests.
--
-- Schema is a minimal subset of WhatsApp Desktop's ChatStorage.sqlite:
--   ZWAMESSAGE, ZWACHATSESSION, ZWAMEDIAITEM
-- Only the columns the WhatsApp connector reads are present. node:sqlite's
-- permissive typing handles BLOB/REAL/INTEGER mapping for synthetic rows.
--
-- KEY/PII_LEAKAGE_ZERO: every JID is a placeholder of the form
-- "1234567890@s.whatsapp.net" or "group-1234@g.us". No real phone numbers,
-- no real names, no real chat content.
--
-- The planted test edge cases — one row each:
--   ROWID 1: outbound 1:1 text     → first_party
--   ROWID 2: inbound 1:1 text      → second_party_dm
--   ROWID 3: outbound group text   → first_party
--   ROWID 4: inbound group text    → third_party_inferred
--   ROWID 5: link preview (ZMESSAGETYPE=7) with a remote media URL
--                                  → message row with no reaction kind
--   ROWID 6: broadcast (session_type=2) → consent third_party_inferred,
--            Stage-0 DROP via broadcast rule
--   ROWID 7: media row with NULL ZTEXT — Stage-0 DROP via media_no_caption
--
-- WhatsApp's ZMESSAGEDATE is Core Data seconds since 2001-01-01 (REAL).
-- We use values around 770000000 (year ~2025) for representativeness.

CREATE TABLE ZWACHATSESSION (
  Z_PK INTEGER PRIMARY KEY AUTOINCREMENT,
  ZSESSIONTYPE INTEGER,
  ZCONTACTJID TEXT,
  -- WU-whatsapp-name-recovery: the SINGLE label column for every JID class —
  -- group subject for @g.us, saved contact / display name for 1:1. The
  -- connector SELECTs s.ZPARTNERNAME for forward session_label stamping.
  ZPARTNERNAME TEXT
);

CREATE TABLE ZWAMEDIAITEM (
  Z_PK INTEGER PRIMARY KEY AUTOINCREMENT,
  ZMEDIALOCALPATH TEXT,
  ZMEDIAURL TEXT,
  ZTITLE TEXT,
  ZMETADATA BLOB
);

-- WU-whatsapp-name-recovery: ZWAPROFILEPUSHNAME is the JID -> self-set push
-- name cache, used as the fallback when ZPARTNERNAME is only a formatted phone
-- string. All values are synthetic placeholders (no real numbers / names).
CREATE TABLE ZWAPROFILEPUSHNAME (
  Z_PK INTEGER PRIMARY KEY AUTOINCREMENT,
  ZJID TEXT,
  ZPUSHNAME TEXT
);

-- WORKUNIT wa-sender-names: ZWAGROUPMEMBER is the per-(group, member) row that
-- carries the GROUP-MESSAGE sender's display name + own jid. ZWAMESSAGE.ZGROUPMEMBER
-- (FK -> Z_PK) resolves the sender of a @g.us message. Mirrors the live schema:
--   ZCONTACTNAME : saved display name (null on this host for all members)
--   ZFIRSTNAME   : first-name fallback (populated for ~15% of members)
--   ZMEMBERJID   : the member's own jid (always populated; the stable sender id)
-- Only the columns the connector + sender-index read are present.
CREATE TABLE ZWAGROUPMEMBER (
  Z_PK INTEGER PRIMARY KEY AUTOINCREMENT,
  ZCONTACTNAME TEXT,
  ZFIRSTNAME TEXT,
  ZMEMBERJID TEXT
);

CREATE TABLE ZWAMESSAGE (
  Z_PK INTEGER PRIMARY KEY AUTOINCREMENT,
  ZSTANZAID TEXT,
  ZTEXT TEXT,
  ZISFROMME INTEGER,
  ZMESSAGETYPE INTEGER DEFAULT 0,
  ZGROUPEVENTTYPE INTEGER DEFAULT 0,
  ZCHATSESSION INTEGER,
  ZPARENTMESSAGE INTEGER,
  ZMESSAGEDATE REAL,
  ZFROMJID TEXT,
  ZTOJID TEXT,
  ZMEDIAITEM INTEGER,
  -- F-T2-WHATSAPP-F6: surface ZSTARRED so the salience tier can boost
  -- operator-starred messages. Added to the fixture so the connector's
  -- SELECT m.ZSTARRED AS starred prepare statement succeeds.
  ZSTARRED INTEGER DEFAULT 0,
  -- WORKUNIT wa-sender-names: FK to ZWAGROUPMEMBER.Z_PK — the sender member of a
  -- @g.us message. NULL for 1:1 (sender == ZFROMJID). Added so the connector's
  -- LEFT JOIN ZWAGROUPMEMBER ... ON gm.Z_PK = m.ZGROUPMEMBER prepares cleanly.
  ZGROUPMEMBER INTEGER
);

-- Chat sessions:
--   1: 1:1 chat with placeholder contact — ZPARTNERNAME is a SAVED name
--      ("Alex Placeholder") → forward session_label resolves directly.
--   2: group chat — ZPARTNERNAME holds the GROUP SUBJECT ("Placeholder Group
--      Chat") → forward session_label is the subject (no ZWAGROUPINFO needed).
--   3: broadcast list (ZSESSIONTYPE=2)
-- WU-whatsapp-name-recovery: ZPARTNERNAME added so the connector's
-- SELECT s.ZPARTNERNAME prepare statement succeeds and the forward
-- session_label / session_partner_name stamping is exercised.
INSERT INTO ZWACHATSESSION (Z_PK, ZSESSIONTYPE, ZCONTACTJID, ZPARTNERNAME)
  VALUES (1, 0, '1234567890@s.whatsapp.net', 'Alex Placeholder');
INSERT INTO ZWACHATSESSION (Z_PK, ZSESSIONTYPE, ZCONTACTJID, ZPARTNERNAME)
  VALUES (2, 1, 'group-1234@g.us', 'Placeholder Group Chat');
INSERT INTO ZWACHATSESSION (Z_PK, ZSESSIONTYPE, ZCONTACTJID, ZPARTNERNAME)
  VALUES (3, 2, 'status@broadcast', NULL);

-- Pushname cache: the phone-only DM JID maps to a self-set push name so the
-- fallback path can be exercised. (Session 1 already resolves via ZPARTNERNAME;
-- this row demonstrates the JID -> pushname fallback for a phone-only session.)
-- Row 2 covers the GROUP-MEMBER pushname fallback (member 2 below has neither a
-- contact nor a first name; its sender_name must resolve via this push name).
INSERT INTO ZWAPROFILEPUSHNAME (Z_PK, ZJID, ZPUSHNAME)
  VALUES (1, '9876543210@s.whatsapp.net', 'Pushname Person');
INSERT INTO ZWAPROFILEPUSHNAME (Z_PK, ZJID, ZPUSHNAME)
  VALUES (2, '9999999999@s.whatsapp.net', 'Group Member Pushname');

-- WORKUNIT wa-sender-names: group members.
--   Member 1: resolves via ZFIRSTNAME (ZCONTACTNAME null, mirroring this host).
--   Member 2: NO saved name (both null) → resolves via ZWAPROFILEPUSHNAME on its
--             ZMEMBERJID; sender_jid is always the member jid.
INSERT INTO ZWAGROUPMEMBER (Z_PK, ZCONTACTNAME, ZFIRSTNAME, ZMEMBERJID)
  VALUES (1, NULL, 'Member Firstname', '8888888888@s.whatsapp.net');
INSERT INTO ZWAGROUPMEMBER (Z_PK, ZCONTACTNAME, ZFIRSTNAME, ZMEMBERJID)
  VALUES (2, NULL, NULL, '9999999999@s.whatsapp.net');

-- Media item used by ROWID 7 (media-no-caption row).
INSERT INTO ZWAMEDIAITEM (Z_PK, ZMEDIALOCALPATH, ZTITLE)
  VALUES (1, 'Media/image-placeholder.jpg', NULL);

-- A text-only media item carrying a minimal contextInfo-shaped protobuf.
-- Field 1 is an unrelated varint; field 5 is the quoted stanza id.
INSERT INTO ZWAMEDIAITEM (Z_PK, ZMEDIALOCALPATH, ZTITLE, ZMETADATA)
  VALUES (2, NULL, NULL,
          X'08012A143341303031313232333334343535363637373838');

-- A planted malformed length-delimited field. The connector must ignore it.
INSERT INTO ZWAMEDIAITEM (Z_PK, ZMEDIALOCALPATH, ZTITLE, ZMETADATA)
  VALUES (3, NULL, NULL, X'2A80');

-- Remote link preview: URL and title are present without a downloaded asset.
INSERT INTO ZWAMEDIAITEM (Z_PK, ZMEDIALOCALPATH, ZMEDIAURL, ZTITLE)
  VALUES (4, NULL, 'https://lu.ma/fixture-event', 'Fixture event - Luma');

-- ROWID 1: outbound 1:1 text → first_party
INSERT INTO ZWAMESSAGE
  (Z_PK, ZSTANZAID, ZTEXT, ZISFROMME, ZMESSAGETYPE, ZGROUPEVENTTYPE,
   ZCHATSESSION, ZPARENTMESSAGE, ZMESSAGEDATE, ZFROMJID, ZTOJID, ZMEDIAITEM)
  VALUES (1, 'stanza-msg-1', 'outbound 1:1 message body',
          1, 0, 0, 1, NULL, 770000000.0, NULL,
          '1234567890@s.whatsapp.net', NULL);

-- ROWID 2: inbound 1:1 text → second_party_dm
INSERT INTO ZWAMESSAGE
  (Z_PK, ZSTANZAID, ZTEXT, ZISFROMME, ZMESSAGETYPE, ZGROUPEVENTTYPE,
   ZCHATSESSION, ZPARENTMESSAGE, ZMESSAGEDATE, ZFROMJID, ZTOJID, ZMEDIAITEM)
  VALUES (2, 'stanza-msg-2', 'inbound 1:1 message body',
          0, 0, 0, 1, NULL, 770000060.0,
          '1234567890@s.whatsapp.net', NULL, NULL);

-- ROWID 3: outbound group text → first_party
INSERT INTO ZWAMESSAGE
  (Z_PK, ZSTANZAID, ZTEXT, ZISFROMME, ZMESSAGETYPE, ZGROUPEVENTTYPE,
   ZCHATSESSION, ZPARENTMESSAGE, ZMESSAGEDATE, ZFROMJID, ZTOJID, ZMEDIAITEM)
  VALUES (3, 'stanza-msg-3', 'outbound group message body',
          1, 0, 0, 2, NULL, 770000120.0, NULL, 'group-1234@g.us', 3);

-- ROWID 4: inbound group text → third_party_inferred.
-- WORKUNIT wa-sender-names: ZGROUPMEMBER → member 1, whose sender_name resolves
-- via ZFIRSTNAME ("Member Firstname") and sender_jid is its ZMEMBERJID.
-- ZFROMJID is the member jid for a @g.us inbound on this host's schema.
INSERT INTO ZWAMESSAGE
  (Z_PK, ZSTANZAID, ZTEXT, ZISFROMME, ZMESSAGETYPE, ZGROUPEVENTTYPE,
   ZCHATSESSION, ZPARENTMESSAGE, ZMESSAGEDATE, ZFROMJID, ZTOJID, ZMEDIAITEM,
   ZGROUPMEMBER)
  VALUES (4, 'stanza-msg-4', 'inbound group message body',
          0, 0, 0, 2, NULL, 770000180.0,
          '8888888888@s.whatsapp.net', 'group-1234@g.us', 2,
          1);

-- ROWID 5: remote link preview (ZMESSAGETYPE=7).
-- Consent is classified by the author rule (outbound here → first_party).
INSERT INTO ZWAMESSAGE
  (Z_PK, ZSTANZAID, ZTEXT, ZISFROMME, ZMESSAGETYPE, ZGROUPEVENTTYPE,
   ZCHATSESSION, ZPARENTMESSAGE, ZMESSAGEDATE, ZFROMJID, ZTOJID, ZMEDIAITEM)
  VALUES (5, 'stanza-msg-5', 'Event details: https://lu.ma/fixture-event',
          1, 7, 0, 1, NULL, 770000240.0, NULL,
          '1234567890@s.whatsapp.net', 4);

-- ROWID 6: broadcast (session_type=2) — inbound status update.
INSERT INTO ZWAMESSAGE
  (Z_PK, ZSTANZAID, ZTEXT, ZISFROMME, ZMESSAGETYPE, ZGROUPEVENTTYPE,
   ZCHATSESSION, ZPARENTMESSAGE, ZMESSAGEDATE, ZFROMJID, ZTOJID, ZMEDIAITEM)
  VALUES (6, 'stanza-msg-6', 'broadcast status text',
          0, 0, 0, 3, NULL, 770000300.0,
          '1234567890@s.whatsapp.net', 'status@broadcast', NULL);

-- ROWID 7: media row with NULL caption — should DROP via media_no_caption.
INSERT INTO ZWAMESSAGE
  (Z_PK, ZSTANZAID, ZTEXT, ZISFROMME, ZMESSAGETYPE, ZGROUPEVENTTYPE,
   ZCHATSESSION, ZPARENTMESSAGE, ZMESSAGEDATE, ZFROMJID, ZTOJID, ZMEDIAITEM)
  VALUES (7, 'stanza-msg-7', NULL,
          0, 0, 0, 1, NULL, 770000360.0,
          '1234567890@s.whatsapp.net', NULL, 1);

-- ROWID 8: empty non-media body with group-event provenance. Stage-0 classifies
-- the missing content independently of ZGROUPEVENTTYPE.
-- WORKUNIT wa-sender-names: ZGROUPMEMBER → member 2 (NO saved name) so the
-- sender_name resolves via the ZWAPROFILEPUSHNAME fallback keyed on the member
-- jid ("Group Member Pushname"). The connector raw_content sender fields are
-- exercised before Stage-0 applies its content rule.
INSERT INTO ZWAMESSAGE
  (Z_PK, ZSTANZAID, ZTEXT, ZISFROMME, ZMESSAGETYPE, ZGROUPEVENTTYPE,
   ZCHATSESSION, ZPARENTMESSAGE, ZMESSAGEDATE, ZFROMJID, ZTOJID, ZMEDIAITEM,
   ZGROUPMEMBER)
  VALUES (8, 'stanza-msg-8', NULL,
          0, 6, 1, 2, NULL, 770000420.0,
          '9999999999@s.whatsapp.net', 'group-1234@g.us', NULL,
          2);
