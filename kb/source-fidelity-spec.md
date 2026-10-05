# Source Fidelity Spec — iMessage Typedstream + ScreenTime Stream Coverage

Status: SPEC (downstream agents implement against this).
Probed: against a real Messages `chat.db` (`attributedBody` blobs) and a real Screen Time `knowledgeC.db`.
Scope: fix the two defects surfaced by the post-activation inspection. Salience filtering, watermark daemon coverage of new ledgers, and Phase 2c are explicitly out of scope.

---

## 1. knowledgeC.db stream catalog (as observed on one machine)

Top streams by row count from `SELECT ZSTREAMNAME, COUNT(*) FROM ZOBJECT GROUP BY ZSTREAMNAME`:

| # | ZSTREAMNAME                  | rows  | Carries signal? |
|---|------------------------------|-------|-----------------|
| 1 | `/discoverability/signals`   | 5,361 | No (Spotlight invocation pings; no query content) |
| 2 | `/app/intents`               | 4,638 | YES (Messages send intents w/ contact + thread refs) |
| 3 | `/app/usage`                 | 3,445 | YES (already captured; baseline) |
| 4 | `/notification/usage`        | 3,326 | YES (bundle id of notifying app + identifier) |
| 5 | `/display/isBacklit`         |   884 | No (state pings) |
| 6 | `/bluetooth/isConnected`     |   260 | No (state pings) |
| 7 | `/app/mediaUsage`            |   122 | Low (bundle only; URL columns null on this op) |
| 8 | `/app/webUsage`              |     7 | YES when present (Safari URL + domain) |
| - | `/knowledge-sync-*`          |   235 | No (sync bookmarks) |

NOT present on this operator (despite spec referencing them): `/safari/history`, `/search/queryusage`, `/app/inFocus`, `/focus/state`. The connector's previous error log ("68 sqlite_query_failed") came from speculative per-stream queries against ZOBJECT — those streams simply do not exist in this knowledgeC.db. The fix is to drop blind per-stream queries and use a single join against `ZSTRUCTUREDMETADATA` with NULL-tolerant per-stream field selection.

### Per-stream row-builder spec (confirmed populated only)

ALL rows are read via ONE query joining `ZOBJECT o` to `ZSTRUCTUREDMETADATA m ON m.Z_PK = o.ZSTRUCTUREDMETADATA`, filtered by `o.ZSTREAMNAME IN (...)`. There is no need to per-stream branch the SQL — branch the row-builder.

`raw_content.stream` mirrors `ZSTREAMNAME`. Common fields on every row: `start_ts`, `end_ts` (mac-epoch + 978307200), `bundle_id = ZVALUESTRING`, `z_pk`. <!-- spec-sweep:allow -->

- `/app/usage` — unchanged from current shape. `raw_content = {stream, bundle_id, start_ts, end_ts, duration_s}`. <!-- spec-sweep:allow -->
- `/app/intents` — `raw_content = {stream, bundle_id, start_ts, intent_class, intent_verb, direction, intent_type, handling_status, interaction_id, derived_intent_id, related_contact_ids, donated_by_siri}`. Source columns: `Z_DKINTENTMETADATAKEY__INTENTCLASS`, `__INTENTVERB`, `__DIRECTION`, `__INTENTTYPE`, `__INTENTHANDLINGSTATUS`, `__INTERACTIONIDENTIFIER`, `__DERIVEDINTENTIDENTIFIER`, `__RELATEDCONTACTIDENTIFIERS`, `__DONATEDBYSIRI`. <!-- spec-sweep:allow -->
- `/notification/usage` — `raw_content = {stream, bundle_id, start_ts, action: ZVALUESTRING ("Receive" etc.), notifying_bundle_id, notification_id}`. Source columns: `Z_DKNOTIFICATIONUSAGEMETADATAKEY__BUNDLEID`, `__IDENTIFIER`. <!-- spec-sweep:allow -->
- `/app/webUsage` — `raw_content = {stream, bundle_id, start_ts, end_ts, web_domain, web_url, usage_type}`. Source columns: `Z_DKDIGITALHEALTHMETADATAKEY__WEBDOMAIN`, `__WEBPAGEURL`, `__USAGETYPE`. <!-- spec-sweep:allow -->
- `/discoverability/signals` — `raw_content = {stream, bundle_id, start_ts, signal: ZVALUESTRING, os_build}`. Source: `Z_DKDISCOVERABILITYSIGNALSMETADATAKEY__OSBUILD`. Captured but low-signal; flag for the future salience filter. <!-- spec-sweep:allow -->
- `/app/mediaUsage` — `raw_content = {stream, bundle_id, start_ts, end_ts, media_url, app_url}`. Source: `Z_DKAPPMEDIAUSAGEMETADATAKEY__MEDIAURL`, `__URL` (both null on this operator; still include columns for portability). <!-- spec-sweep:allow -->

Rows where the stream is not in the configured set MUST be skipped silently (no error log) so the cursor still advances. This kills the 68 `sqlite_query_failed` count.

---

## 2. iMessage typedstream decoder spec

### Wire format (observed on macOS 26)

Every `attributedBody` blob begins with the literal ASCII bytes `streamtyped` preceded by a 4-byte preamble `04 0b` plus the magic identifier byte sequence — the preamble is the same on every blob inspected: `04 0b 73 74 72 65 61 6d 74 79 70 65 64 81 e8 03 84 01 40 84 84 84 19 4e 53 4d 75 74 61 62 6c 65 41 74 74 72 69 62 75 74 65 64 53 74 72 69 6e 67 00`. The class chain that follows is always `NSMutableAttributedString → NSAttributedString → NSObject → NSMutableString → NSString` for the canonical text payload.

The canonical text NSString is preceded by the START_PATTERN `[0x01, 0x2b]` (matches upstream `imessage-exporter/streamtyped.rs` constants). Immediately after START_PATTERN comes a variable-length integer encoding the UTF-8 byte length:

- `b < 0x81`        → length = b                          (1-byte form, used for messages 1..128 bytes)
- `b == 0x81`       → length = u16 LE of next 2 bytes     (used for messages 129..65535 bytes)
- `b == 0x82`       → length = u32 LE of next 4 bytes     (used for very long messages)

Then exactly `length` UTF-8 bytes of the message text. END_PATTERN `[0x86, 0x84]` terminates the canonical string.

Worked examples (constructed for this document: the message texts are invented, the length-prefix arithmetic is exactly what the decoder performs):
- Example A: `b=0x81 96 00` → u16 LE 0x0096 = 150 bytes of text follow, e.g. a notice opening `"Your parcel from Example Outfitters is out for delivery..."`.
- Example B: `b=0x81 9d 00` → u16 LE 0x009d = 157 bytes, e.g. a reminder opening `"Reminder: the library book you borrowed is due back..."`.
- Example C: `b=0x81 07 02` → u16 LE 0x0207 = 519 bytes, e.g. a long newsletter-style text opening `"Hello neighbors, the spring cleanup schedule for the block..."`.
- Example D: `b=0x44`        → single byte 0x44 = 68 bytes, e.g. `"Table for four is booked at the corner bistro, Friday at half past 7"` (68 ASCII bytes).
- Example E: `b=0x74`        → single byte 0x74 = 116 bytes, e.g. an appointment text opening `"Your dental cleaning is confirmed for Tuesday morning..."`.

The legacy 0xFF length-escape mentioned in older Apple typedstream docs did not show up in any blob inspected while writing this spec — Apple uses the `0x81/0x82` sentinel form on Tahoe. Decoder must handle both forms for portability (treat `0xFF` as legacy 4-byte LE escape if ever encountered, but do not require it).

### Public surface

```js
// <checkout>/mcp/lib/connectors/imessage.js
// Replace the existing decodeAttributedBody with this surface.

/**
 * Decode the canonical message text from a typedstream-encoded
 * NSAttributedString blob (the chat.db message.attributedBody column).
 *
 * @param {Uint8Array | Buffer} blob
 * @returns {{ text: string, attributes?: object } | null}
 *   Returns null on any parse failure. Caller falls back to message.text.
 *   `attributes` is reserved for future use (URL spans, OTP codes, calendar
 *   event refs); v1 MAY return undefined.
 */
export function parseTypedstream(blob)
```

### Internal decomposition

```
parseTypedstream(buf)
├── validateHeader(buf)
│     // verify buf starts with the 13-byte streamtyped magic
│     //   bytes [0..1]   == [0x04, 0x0b]
│     //   bytes [2..12]  == "streamtyped" ASCII
│     // returns offset past the magic, or -1
├── findCanonicalStringStart(buf, offset)
│     // scan forward for START_PATTERN [0x01, 0x2b].
│     // The match MUST occur AFTER the class chain (i.e. after the last
│     // 'NSString' literal). We use indexOf from `offset` and accept the
│     // first match WHOSE IMMEDIATELY-PRECEDING byte is a documented
│     // typedstream framing tag: 0x84 (class-instance) or 0x95 (back-ref).
│     //
│     // R23 DEFENSIVE GUARD (per R22 brutalist DOWNGRADE + R23 A3 empirical
│     // survey of a typedstream corpus):
│     //   - 14,891 / 14,891 (100.0%) successful chat.db decodes have 0x84
│     //     as the byte immediately before the canonical [0x01,0x2b].
│     //   - 911 / 14,891 (6.1%) blobs contain ADDITIONAL [0x01,0x2b]
│     //     occurrences inside embedded NSAttributeInfo dicts, preceded by
│     //     ASCII content bytes (0x22, 0x49, 0x28, ...). The bare-indexOf
│     //     shortcut would mis-decode these in any wire-format change that
│     //     reordered the class chain. The guard rejects such pretenders.
│     //   - 0x95 (back-reference tag) is NOT observed as an immediate
│     //     predecessor in this corpus but is admitted because the Rust
│     //     reference encoder uses it interchangeably with 0x84.
│     //
│     // On a non-framed candidate the parser increments decodeStats.
│     // suspicious_rejected and walks forward to the next [0x01,0x2b].
│     // If no framed candidate exists, returns -1 (caller falls back to
│     // the legacy m.text TEXT column).
│     // returns offset past the 2-byte START_PATTERN, or -1
├── readVarLen(buf, offset)
│     // read 1 byte:
│     //   b < 0x81    → return { len: b, next: offset+1 }
│     //   b == 0x81   → return { len: buf.readUInt16LE(offset+1), next: offset+3 }
│     //   b == 0x82   → return { len: buf.readUInt32LE(offset+1), next: offset+5 }
│     //   b == 0xFF   → (legacy) length = buf.readUInt32LE(offset+1), next +5
│     //   else         → null (parser bails)
├── decodeUtf8(buf, offset, len)
│     // bounds-check: offset + len <= buf.length, else null.
│     // returns buf.slice(offset, offset+len).toString("utf8")
│     // NSString in this stream is always UTF-8 on macOS — UTF-16 form is
│     // possible per typedstream spec but has NOT been observed in any
│     // chat.db blob to date. If we ever see it (NSMutableString with the
│     // UTF-16 tag), the decoder should bail to null rather than misdecode.
└── return { text }
```

Error policy: ANY of the above returning a sentinel value → `parseTypedstream` returns `null`. The caller already handles null + `decode_error=true`. No exceptions cross the boundary.

The current "length-prefix heuristic with first-plausible-match acceptance" in `decodeAttributedBody` is DELETED; the new `parseTypedstream` replaces it. The connector's `buildRow` continues to call the new function in the same place.

---

## 3. Test fixture spec (HERMETIC — no real chat.db reads)

Synthetic blob built byte-by-byte in the test. Target plaintext: `"the sample contact is Robin; they work in Dayton"` (48 ASCII bytes; fits the single-byte length form, exercising the most common path).

### Hex preamble (constant header — the same on every blob inspected)

```
04 0b 73 74 72 65 61 6d 74 79 70 65 64           // "\x04\x0bstreamtyped"
81 e8 03                                          // version 0x03e8 = 1000
84 01 40                                          // typedstream framing
84 84 84 19                                       // class def, len 0x19 = 25
4e 53 4d 75 74 61 62 6c 65 41 74 74 72 69 62      // "NSMutableAttrib
75 74 65 64 53 74 72 69 6e 67 00                  //  utedString\0"
84 84 12                                          // class def, len 0x12 = 18
4e 53 41 74 74 72 69 62 75 74 65 64 53 74 72      // "NSAttributedStr
69 6e 67 00                                       //  ing\0"
84 84 08                                          // class def, len 0x08 = 8
4e 53 4f 62 6a 65 63 74 00                        // "NSObject\0"
85 92 84 84 84 0f                                 // back-ref + class def len 0x0f = 15
4e 53 4d 75 74 61 62 6c 65 53 74 72 69 6e 67 01   // "NSMutableString\x01"
84 84 08                                          // class def, len 0x08 = 8
4e 53 53 74 72 69 6e 67 01                        // "NSString\x01"
95 84 01 2b                                       // START_PATTERN preceded by 95 84 framing
30                                                // length = 48 (decimal 48 = 0x30)
74 68 65 20 73 61 6d 70 6c 65 20 63 6f 6e 74 61  // "the sample conta"
63 74 20 69 73 20 52 6f 62 69 6e 3b 20 74 68 65  // "ct is Robin; the"
79 20 77 6f 72 6b 20 69 6e 20 44 61 79 74 6f 6e  // "y work in Dayton"
86 84                                             // END_PATTERN
```

(Note: the back-ref byte `0x95` immediately before `0x84 0x01 0x2b` is what was observed on every real blob; tests SHOULD assert this exact sequence is matched, not just `[0x01,0x2b]` alone in isolation. The decoder however only needs to find `[0x01,0x2b]` to function correctly.)

Test must assert:
1. `parseTypedstream(fixture).text === "the sample contact is Robin; they work in Dayton"`.
2. `parseTypedstream(fixtureTruncatedTo20Bytes) === null`.
3. `parseTypedstream(fixtureWithJunkPrefix) === null` (missing streamtyped magic).
4. `parseTypedstream(fixtureWithCorruptedLength) === null` (declared length runs past buffer end).
5. A second variant with `b=0x81` form (length > 128) decodes correctly.
6. A third variant with `b=0x82` form (length > 65535) decodes correctly.

NO test reads `~/Library/Messages/chat.db` or `~/Library/Application Support/Knowledge/knowledgeC.db`.

---

## 4. Reclassification ops (operator runbook)

After the two fixes land and tests pass:

```bash
# 1. Stop the launchd-registered daemons.
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.user.memory-system.imessage-connector.plist
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.user.memory-system.screentime-connector.plist

# 2. Delete the corrupted source ledgers + their state cursors.
#    (80,432 events were 98% placeholder garbage; no real signal lost.)
rm -f "$MEMORY_ROOT"/storage/sources/imessage.jsonl
rm -f "$MEMORY_ROOT"/storage/sources/screentime.jsonl
rm -f "$MEMORY_ROOT"/connectors/imessage/state.json
rm -f "$MEMORY_ROOT"/connectors/screentime/state.json

# 3. Re-run each connector once to verify the new decoder + stream coverage.
node \
  "$MEMORY_ROOT"/mcp/lib/connectors/imessage.js --once
node \
  "$MEMORY_ROOT"/mcp/lib/connectors/screentime.js --once

# 4. Re-load the daemons.
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.user.memory-system.imessage-connector.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.user.memory-system.screentime-connector.plist
```

### Post-fix data-quality probes (operator runs these to confirm)

```bash
# iMessage: assert median text length > 20 chars on the last 100 events.
node -e '
  const fs = require("node:fs");
  const lines = fs.readFileSync(process.env.MEMORY_ROOT + "/storage/sources/imessage.jsonl","utf8")
    .trim().split("\n").slice(-100);
  const lens = lines.map(l => (JSON.parse(l).raw_content?.text || "").length).sort((a,b)=>a-b);
  console.log("median len:", lens[50], "p90 len:", lens[90]);
'

# ScreenTime: assert at least 3 distinct streams appear in the ledger.
node -e '
  const fs = require("node:fs");
  const lines = fs.readFileSync(process.env.MEMORY_ROOT + "/storage/sources/screentime.jsonl","utf8")
    .trim().split("\n");
  const streams = new Set(lines.map(l => JSON.parse(l).raw_content?.stream));
  console.log("distinct streams:", [...streams]);
'
```

Pass criteria:
- iMessage median raw_content.text length ≥ 20 chars (was 1).
- ScreenTime distinct streams ≥ 3 (was 1).
- `state.json.error_count` on screentime ≤ 5 (was 68; should be near-zero).
- Existing 809 PASS / 0 FAIL test count holds.
- spec-sweep 0-hit gate passes.
- snapshot-test-protected.mjs reports byte-identical production state pre/post `npm test`.

The watermark daemon will continue NOT to tail these new ledgers — that is a separate concern tracked in `kb/open-problems.md`.
