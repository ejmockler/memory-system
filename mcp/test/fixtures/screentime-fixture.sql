-- screentime-fixture.sql — synthetic knowledgeC.db for hermetic ScreenTime
-- connector tests.
--
-- Schema is the minimal subset of macOS CoreDuet knowledgeC.db that the
-- ScreenTime connector reads: ZOBJECT with the five columns named in
-- mcp/lib/connectors/screentime.js queryZobjectPage SELECT list.
--
-- Mac Absolute Time epoch = 2001-01-01T00:00:00Z. Our fixture timestamps:
--   ZSTARTDATE 770000000 == 2025-05-29T13:33:20.000Z
--   ZSTARTDATE 770000060 == 2025-05-29T13:34:20.000Z  (60s later)
-- Both well inside the operator's plausible recent past, no clock-skew risk.
--
-- Eight fixture rows — one per relevant edge case:
--   Z_PK 10: /app/usage           — Safari foreground 60s (ZVALUESTRING)
--   Z_PK 11: /app/inFocus         — Terminal focus slice
--   Z_PK 12: /safari/history      — visited URL+title via ZSTRUCTUREDMETADATA
--   Z_PK 13: /search/queryusage   — Spotlight query via ZSTRUCTUREDMETADATA
--   Z_PK 14: /audio/now-playing   — IGNORED (not in ALLOWED_STREAMS); the
--                                   test asserts the page-filter drops it.
--   Z_PK 15: /app/usage           — second app-usage row, to verify cursor
--                                   monotonicity restart-recovery.
--   Z_PK 16: /focus/state         — Focus-mode active/inactive transition
--                                   (source-fidelity round; spec § 1).
--   Z_PK 17: /coreduet/clientstate — unrecognized stream; the test asserts
--                                    the connector skips it silently (no
--                                    error_count increment).
--   Z_PK 18: /app/usage           — R23 audit-fixture-drift CRIT-D:
--                                   ZSTARTDATE = -63114076800 (≈ year 0 in
--                                   Mac Absolute Time, a knowledgeC sentinel value).
--                                   Tests that macAbsoluteToIso bails to null
--                                   instead of throwing "Invalid time value".
--   Z_PK 19: /focus/state         — R23 audit-fixture-drift HIGH-F:
--                                   ZVALUEINTEGER = 9000000000000000001
--                                   (synthetic 64-bit hash-shaped value, >2^53).
--                                   Tests that the BigInt-unsafe SELECT path
--                                   (CAST AS TEXT) does not throw; tests that
--                                   buildFocusState does NOT use the hash
--                                   value as a boolean fallback.
--   Z_PK 20: /app/intents         — R23 audit-bigint-catalog overflow witness:
--                                   ZVALUEINTEGER = -9000000000000000002
--                                   (synthetic negative 64-bit hash-shaped value).
--                                   Tests negative-overflow path.
--   Z_PK 21: /knowledge-sync-deletion-bookmark/00000000-0000-0000-0000-000000000001
--                                 — R27 HIGH-G: unrecognized-stream with
--                                   UUID-suffix shape. knowledgeC.db can hold
--                                   many such rows per day; previously zero
--                                   regression coverage. Connector must
--                                   silently skip (no error_count++), cursor
--                                   still advances past it.
--   Z_PK 22: /display/isBacklit   — R27 HIGH-G: unrecognized-stream with
--                                   ZVALUEINTEGER carrying a boolean (1).
--                                   Common in knowledgeC.db. Same silent-skip
--                                   requirement.
--
-- ZSTRUCTUREDMETADATA carries per-stream typed fields the connector reads
-- via LEFT JOIN m.Z_PK = o.ZSTRUCTUREDMETADATA. Each row holds the named
-- columns the spec-§-1 per-stream row-builder reads. NULL columns are fine;
-- the connector tolerates missing fields.

-- R23: real knowledgeC.db stores ZSTARTDATE/ZENDDATE as INTEGER seconds
-- (audit-bigint-catalog corrected the earlier REAL assumption). Fixture
-- preserves INTEGER affinity for cross-type drift coverage. ZVALUEINTEGER
-- added so the connector's PRAGMA-driven projection can exercise the
-- BigInt-unsafe CAST AS TEXT path.
CREATE TABLE ZOBJECT (
  Z_PK                   INTEGER PRIMARY KEY,
  ZSTREAMNAME            TEXT,
  ZSTARTDATE             INTEGER,
  ZENDDATE               INTEGER,
  ZVALUESTRING           TEXT,
  ZVALUEINTEGER          INTEGER,
  ZSTRUCTUREDMETADATA    INTEGER
);

CREATE TABLE ZSTRUCTUREDMETADATA (
  Z_PK                                                  INTEGER PRIMARY KEY,
  -- /safari/history fields
  Z_DKSAFARIHISTORYMETADATAKEY__URL                     TEXT,
  Z_DKSAFARIHISTORYMETADATAKEY__TITLE                   TEXT,
  -- /search/queryusage fields
  Z_DKSEARCHQUERYUSAGEMETADATAKEY__QUERYSTRING          TEXT,
  -- /focus/state fields
  Z_DKFOCUSSTATEMETADATAKEY__ACTIVE                     INTEGER,
  Z_DKFOCUSSTATEMETADATAKEY__MODEIDENTIFIER             TEXT,
  -- /app/intents fields (R23: row 20 exercises BigInt overflow on bundled intent)
  Z_DKINTENTMETADATAKEY__INTENTCLASS                    TEXT,
  Z_DKINTENTMETADATAKEY__INTENTVERB                     TEXT,
  Z_DKINTENTMETADATAKEY__DIRECTION                      INTEGER,
  Z_DKINTENTMETADATAKEY__INTENTTYPE                     INTEGER,
  Z_DKINTENTMETADATAKEY__INTENTHANDLINGSTATUS           INTEGER,
  Z_DKINTENTMETADATAKEY__INTERACTIONIDENTIFIER          TEXT,
  Z_DKINTENTMETADATAKEY__DERIVEDINTENTIDENTIFIER        TEXT,
  Z_DKINTENTMETADATAKEY__RELATEDCONTACTIDENTIFIERS      TEXT,
  Z_DKINTENTMETADATAKEY__DONATEDBYSIRI                  INTEGER
);

-- ZOBJECT rows. The trailing column (ZSTRUCTUREDMETADATA) is a FK rowid into
-- ZSTRUCTUREDMETADATA; NULL when the stream carries no typed metadata.
--
-- Column order: (Z_PK, ZSTREAMNAME, ZSTARTDATE, ZENDDATE, ZVALUESTRING,
--                ZVALUEINTEGER, ZSTRUCTUREDMETADATA)
--
-- Rows 18-20 are R23 BigInt / edge-case fixtures. The ZVALUEINTEGER
-- magnitudes (9000000000000000001, -9000000000000000002) are synthetic values
-- shaped like knowledgeC.db 64-bit hash identifiers and exceed Number.MAX_SAFE_INTEGER
-- (2^53 - 1 = 9007199254740991). Stored as BIGINT-LITERAL form in SQLite;
-- without CAST(... AS TEXT) projection, node:sqlite stmt.all() throws
-- "Value is too large to be represented as a JavaScript number".
INSERT INTO ZOBJECT VALUES
  (10, '/app/usage',           770000000, 770000060, 'com.apple.Safari',    NULL,                   NULL),
  (11, '/app/inFocus',         770000060, 770000120, 'com.apple.Terminal',  NULL,                   NULL),
  (12, '/safari/history',      770000120, 770000120, NULL,                  NULL,                   100),
  (13, '/search/queryusage',   770000180, 770000180, NULL,                  NULL,                   101),
  (14, '/audio/now-playing',   770000200, 770000260, 'com.spotify.client',  NULL,                   NULL),
  (15, '/app/usage',           770000300, 770000360, 'com.apple.dt.Xcode',  NULL,                   NULL),
  (16, '/focus/state',         770000400, 770000400, NULL,                  NULL,                   102),
  (17, '/coreduet/clientstate',770000500, 770000500, 'irrelevant.string',   NULL,                   NULL),
  (18, '/app/usage',           -63114076800, -63114076800, 'com.apple.legacy',  NULL,               NULL),
  (19, '/focus/state',         770000600, 770000600, NULL,                  9000000000000000001,     103),
  (20, '/app/intents',         770000700, 770000700, 'com.apple.MobileSMS', -9000000000000000002,   104),
  -- R27 HIGH-G fixtures: unrecognized streams with synthetic values in the
  -- shapes knowledgeC.db uses. Both must be silently skipped;
  -- cursor advances past them; error_count stays 0.
  (21, '/knowledge-sync-deletion-bookmark/00000000-0000-0000-0000-000000000001',
                               770000800, 770000800, NULL,                  NULL,                   NULL),
  (22, '/display/isBacklit',   770000900, 770000900, NULL,                  1,                      NULL);

INSERT INTO ZSTRUCTUREDMETADATA (
  Z_PK,
  Z_DKSAFARIHISTORYMETADATAKEY__URL,
  Z_DKSAFARIHISTORYMETADATAKEY__TITLE,
  Z_DKSEARCHQUERYUSAGEMETADATAKEY__QUERYSTRING,
  Z_DKFOCUSSTATEMETADATAKEY__ACTIVE,
  Z_DKFOCUSSTATEMETADATAKEY__MODEIDENTIFIER,
  Z_DKINTENTMETADATAKEY__INTENTCLASS,
  Z_DKINTENTMETADATAKEY__INTENTVERB,
  Z_DKINTENTMETADATAKEY__DIRECTION,
  Z_DKINTENTMETADATAKEY__INTENTTYPE,
  Z_DKINTENTMETADATAKEY__INTENTHANDLINGSTATUS,
  Z_DKINTENTMETADATAKEY__INTERACTIONIDENTIFIER,
  Z_DKINTENTMETADATAKEY__DERIVEDINTENTIDENTIFIER,
  Z_DKINTENTMETADATAKEY__RELATEDCONTACTIDENTIFIERS,
  Z_DKINTENTMETADATAKEY__DONATEDBYSIRI
) VALUES
  (100, 'https://example.com/page', 'Example Page Title', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  (101, NULL, NULL, 'screen time research', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  (102, NULL, NULL, NULL, 1, 'com.apple.donotdisturb.mode.work', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  -- R23 row 19: focus/state with BigInt-hash ZVALUEINTEGER. Typed-column
  -- ACTIVE=0 → focus_mode_active should be `false` (typed source, NOT a
  -- coerced hash). Mode identifier set to confirm the rest of the path.
  (103, NULL, NULL, NULL, 0, 'com.apple.donotdisturb.mode.personal', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  -- R23 row 20: app/intents with negative BigInt-hash ZVALUEINTEGER on the
  -- ZOBJECT row. The intent metadata fields are populated to exercise the
  -- buildAppIntents row-builder under BigInt projection.
  (104, NULL, NULL, NULL, NULL, NULL, 'INSendMessageIntent', 'send', 1, 1, 2, 'interaction-r23', 'derived-r23', 'contact-r23', 1);
