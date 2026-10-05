// _typedstream.js — pure-JS parser for the canonical NSString text inside
// Apple's `typedstream` archive format (the wire format of NSKeyedArchiver's
// classic encoding, used by chat.db.message.attributedBody on macOS Ventura+).
//
// Authoritative spec: kb/source-fidelity-spec.md § 2.
// Reference implementation surface: ReagentX/imessage-exporter,
// imessage-database crate, src/util/typedstream/parser.rs.
//
// Scope: extract the FIRST canonical NSString payload. Attribute spans
// (NSAttribute, NSURL, NSAttachment, etc.) come AFTER the primary text and
// are out of scope for v1. Caller obtains { text, length } on success or
// null on any parse failure; null is the back-pressure signal to fall back
// to the legacy message.text TEXT column.
//
// No npm deps. node:* only — actually only ECMA-262 + Buffer. Pure function.
//
// Wire format (macOS Tahoe 26.x):
//   [0x04, 0x0b]                          — preamble
//   "streamtyped" (11 ASCII bytes)         — magic
//   <version int32 LE>                     — typically 0x000003e8 (1000)
//   <class chain framing>                  — variable
//   [..., 0x84, 0x01, 0x2b]                — START_PATTERN signalling the
//                                            canonical NSString instance
//   <varlen length>                        — 1 byte; if 0x81/0x82/0xFF
//                                            extended form follows
//   <length bytes of UTF-8>                — message text
//   [0x86, 0x84]                           — END_PATTERN (informational; we
//                                            do not require it on the read
//                                            path since the explicit length
//                                            already brackets the payload)
//
// Length encodings:
//   b < 0x81   → length = b                              (covers 0..128)
//   b == 0x81  → length = u16 LE of next 2 bytes         (covers 129..65535)
//   b == 0x82  → length = u32 LE of next 4 bytes         (covers > 65535)
//   b == 0xFF  → length = u32 LE of next 4 bytes         (legacy escape;
//                                                         maintained for
//                                                         portability across
//                                                         older OS variants)
//   else       → null (parser bails)

// 1 MiB cap. Any larger blob is treated as malformed: real chat.db messages
// max out around 16 KiB; gigabyte blobs would only result from corruption
// or attack.
const TYPEDSTREAM_MAX_BUFFER_BYTES = 1048576;

// 13-byte magic: 0x04 0x0b followed by ASCII "streamtyped".
const HEADER_MAGIC = Buffer.from([
  0x04, 0x0b,
  0x73, 0x74, 0x72, 0x65, 0x61, 0x6d, 0x74, 0x79, 0x70, 0x65, 0x64,
]);

// START_PATTERN — the 2-byte sentinel preceding the canonical NSString's
// length-prefixed UTF-8 payload. Per the spec and the reference Rust parser.
const START_PATTERN = Buffer.from([0x01, 0x2b]);

// FRAMING_TAGS — bytes that may legitimately PRECEDE a valid canonical
// [0x01, 0x2b] in a streamtyped archive. Per R23 audit-typedstream-corpus.md
// (Phase A3), 0x84 (class-instance tag) immediately precedes the canonical
// START_PATTERN in 14,891 / 14,891 chat.db blobs on this operator (100%).
// 0x95 (back-reference tag) is documented in the Rust reference parser as
// the alternative encoder choice when the canonical NSString is referenced
// by id rather than re-declared; it does not appear in this corpus as an
// immediate predecessor but is admitted here for cross-OS portability.
//
// Bug-bait pattern (the R22 brutalist DOWNGRADE): future Apple class literal
// containing 0x2b preceded by 0x01 without 0x84/0x95 framing. The guard
// walks forward through successive candidates instead of accepting the first.
const FRAMING_TAG_CLASS_INSTANCE = 0x84;
const FRAMING_TAG_BACK_REFERENCE = 0x95;

// ---------------------------------------------------------------------------
// Parser-internal telemetry. Counters increment in parseTypedstream and
// findCanonicalStringStart so production code can monitor decode-rate
// regressions over time. Buckets are monotonic; resetDecodeStats() zeros them.
//
//   attempts             — non-null inputs entering parseTypedstream
//   successes            — parseTypedstream returned { text, length }
//   header_invalid       — missing/short streamtyped magic
//   start_not_found      — no framed [0x01, 0x2b] in buffer
//   suspicious_rejected  — a [0x01, 0x2b] candidate failed the framing-tag
//                          guard and was skipped (the parser walked forward
//                          to the next candidate or bailed); independent of
//                          final outcome
//   varlen_invalid       — readVarLen sentinel rejection
//   payload_oob          — declared length runs past buffer end
//   utf8_rejected        — UTF-8 round-trip mismatch (e.g. UTF-16 payload)
//   oversized            — blob exceeds TYPEDSTREAM_MAX_BUFFER_BYTES
//
// In production, a non-zero suspicious_rejected count without a matching
// drop in successes is the early signal of a future Apple wire-format change.
// ---------------------------------------------------------------------------
const decodeStats = {
  attempts: 0,
  successes: 0,
  header_invalid: 0,
  start_not_found: 0,
  suspicious_rejected: 0,
  varlen_invalid: 0,
  payload_oob: 0,
  utf8_rejected: 0,
  oversized: 0,
};

export function getDecodeStats() {
  return { ...decodeStats };
}

export function resetDecodeStats() {
  for (const k of Object.keys(decodeStats)) decodeStats[k] = 0;
}

// ---------------------------------------------------------------------------
// validateHeader — verify the 13-byte streamtyped magic. Returns the offset
// past the magic (13) on success, or -1 on any mismatch / short-buffer.
// ---------------------------------------------------------------------------
export function validateHeader(buf) {
  if (!buf || buf.length < HEADER_MAGIC.length) return -1;
  for (let i = 0; i < HEADER_MAGIC.length; i++) {
    if (buf[i] !== HEADER_MAGIC[i]) return -1;
  }
  return HEADER_MAGIC.length;
}

// ---------------------------------------------------------------------------
// findCanonicalStringStart — scan forward from `offset` for START_PATTERN
// [0x01, 0x2b]. Returns the offset of the byte FOLLOWING the 2-byte pattern,
// or -1 if no match exists past the class chain.
//
// Note: in real blobs the START_PATTERN is preceded by `0x95 0x84` framing
// (back-ref + class def tag), but the decoder only needs the pattern itself
// to locate the length byte. The class-chain literals "NSString",
// "NSAttributedString", etc. never include the byte sequence [0x01, 0x2b] —
// they are all printable ASCII with a trailing 0x00 or 0x01 terminator.
//
// R23 defensive byte-tag check (downgrade from R22 brutalist): the byte
// IMMEDIATELY before the first canonical [0x01, 0x2b] in every observed
// chat.db blob (14,891 / 14,891 messages, 100.0%) is 0x84 — the typedstream
// class-def framing tag. The Phase A3 corpus survey also confirmed that 911
// messages (6.1%) contain MULTIPLE [0x01, 0x2b] occurrences, with the
// second-or-later occurrences preceded by ASCII content bytes inside embedded
// NSAttributeInfo dicts (not 0x84). Since `indexOf` finds the FIRST hit, the
// current implementation is empirically safe — but if Apple ever introduces a
// future NSAttributedString subclass literal containing 0x2b preceded by 0x01
// inside the class chain, the bare `indexOf` would mis-decode. The 0x84
// check bails to null in that case, letting the caller fall back to the
// legacy m.text TEXT column.
// ---------------------------------------------------------------------------
export function findCanonicalStringStart(buf, offset) {
  if (!buf || offset < 0 || offset >= buf.length) return -1;
  let searchFrom = offset;
  while (searchFrom < buf.length) {
    const idx = buf.indexOf(START_PATTERN, searchFrom);
    if (idx < 0) return -1;
    // R23 defensive guard (per R23 audit-typedstream-corpus.md + R22
    // brutalist DOWNGRADE): require the byte IMMEDIATELY before the matched
    // [0x01, 0x2b] to be one of the documented framing tags. If the
    // candidate has no preceding byte (idx === 0) or the preceding byte is
    // neither 0x84 (class-instance) nor 0x95 (back-reference), the
    // candidate is treated as bug-bait (likely an ASCII byte inside an
    // embedded NSAttributeInfo dict or a future Apple subclass literal)
    // and we advance to the next [0x01, 0x2b] occurrence.
    const prev = idx >= 1 ? buf[idx - 1] : -1;
    if (prev === FRAMING_TAG_CLASS_INSTANCE || prev === FRAMING_TAG_BACK_REFERENCE) {
      return idx + START_PATTERN.length;
    }
    decodeStats.suspicious_rejected += 1;
    searchFrom = idx + 1;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// readVarLen — decode the variable-length integer at `offset`. Returns
// { len, next } on success, or null on bad sentinel / out-of-bounds.
// ---------------------------------------------------------------------------
export function readVarLen(buf, offset) {
  if (!buf || offset < 0 || offset >= buf.length) return null;
  const b = buf[offset];
  if (b < 0x81) {
    return { len: b, next: offset + 1 };
  }
  if (b === 0x81) {
    if (offset + 2 >= buf.length) return null;
    const len = buf.readUInt16LE(offset + 1);
    return { len, next: offset + 3 };
  }
  if (b === 0x82) {
    if (offset + 4 >= buf.length) return null;
    const len = buf.readUInt32LE(offset + 1);
    return { len, next: offset + 5 };
  }
  if (b === 0xFF) {
    // Legacy 4-byte LE escape. Not observed on Tahoe but documented in
    // older Apple typedstream references; retained for portability.
    if (offset + 4 >= buf.length) return null;
    const len = buf.readUInt32LE(offset + 1);
    return { len, next: offset + 5 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// decodeUtf8 — slice `len` bytes starting at `offset` and decode as UTF-8.
// Returns the decoded string, or null if the slice would run past the end.
//
// UTF-8 vs UTF-16 detection: NSString on macOS chat.db has been observed
// exclusively in UTF-8 form on the typedstream wire as of macOS Tahoe. If a
// UTF-16-tagged NSMutableString variant ever surfaces, the parser bails to
// null rather than risk a misdecode (the caller falls back to the legacy
// m.text column, which is safer than emitting mojibake).
//
// The lightweight UTF-8 check: round-trip the decoded string back through
// UTF-8 encoding and require byte-equality. JavaScript's "utf8" decoding
// replaces invalid sequences with U+FFFD; the round-trip fails byte-equality
// in that case, and we return null.
// ---------------------------------------------------------------------------
export function decodeUtf8(buf, offset, len) {
  if (!buf || offset < 0 || len < 0 || offset + len > buf.length) return null;
  const slice = buf.subarray(offset, offset + len);
  const s = slice.toString("utf8");
  // Round-trip validation — rejects UTF-16-encoded or otherwise non-UTF-8
  // payloads (they would have been silently corrupted by toString("utf8")).
  const reencoded = Buffer.from(s, "utf8");
  if (reencoded.length !== slice.length) return null;
  for (let i = 0; i < slice.length; i++) {
    if (reencoded[i] !== slice[i]) return null;
  }
  return s;
}

// ---------------------------------------------------------------------------
// parseTypedstream — primary public entry.
//
// @param {Uint8Array | Buffer | null | undefined} blob
// @returns {{ text: string, length: number } | null}
//   On success: { text, length } where length is the UTF-8 byte count.
//   On any failure (missing magic, no START_PATTERN, bad varlen,
//   out-of-bounds length, oversized blob, non-UTF-8 payload): null.
//
// Never throws. The caller (imessage.js _buildLedgerRow) treats null as the
// signal to fall back to the legacy m.text TEXT column.
// ---------------------------------------------------------------------------
export function parseTypedstream(blob) {
  if (blob == null) return null;
  let buf;
  if (Buffer.isBuffer(blob)) {
    buf = blob;
  } else if (blob instanceof Uint8Array) {
    buf = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  } else {
    return null;
  }
  if (buf.length === 0) return null;
  decodeStats.attempts += 1;
  if (buf.length > TYPEDSTREAM_MAX_BUFFER_BYTES) {
    decodeStats.oversized += 1;
    return null;
  }

  const afterHeader = validateHeader(buf);
  if (afterHeader < 0) {
    decodeStats.header_invalid += 1;
    return null;
  }

  const afterStart = findCanonicalStringStart(buf, afterHeader);
  if (afterStart < 0) {
    decodeStats.start_not_found += 1;
    return null;
  }

  const lenRead = readVarLen(buf, afterStart);
  if (lenRead == null) {
    decodeStats.varlen_invalid += 1;
    return null;
  }
  // Sanity: zero-length and oversized lengths bail. A zero-length canonical
  // NSString is technically legal but useless to surface; treat as fallback
  // so the legacy text column wins on the rare empty case.
  if (lenRead.len <= 0) {
    decodeStats.varlen_invalid += 1;
    return null;
  }
  if (lenRead.len > TYPEDSTREAM_MAX_BUFFER_BYTES) {
    decodeStats.payload_oob += 1;
    return null;
  }
  if (lenRead.next + lenRead.len > buf.length) {
    decodeStats.payload_oob += 1;
    return null;
  }

  const text = decodeUtf8(buf, lenRead.next, lenRead.len);
  if (text == null) {
    decodeStats.utf8_rejected += 1;
    return null;
  }

  decodeStats.successes += 1;
  return { text, length: lenRead.len };
}

export { TYPEDSTREAM_MAX_BUFFER_BYTES };
