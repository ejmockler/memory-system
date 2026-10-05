// _typedstream-fixture-builder.mjs — synthetic Apple typedstream BLOB builder.
//
// Builds a minimum-viable typedstream-encoded NSAttributedString blob for use
// in hermetic iMessage connector tests. Emits the typedstream byte preamble
// that macOS Tahoe 26.x writes for an NSAttributedString message body, then
// appends a length-prefixed UTF-8 NSString payload using the single-byte
// (b < 0x81), two-byte (b == 0x81 u16 LE), or four-byte (b == 0x82 u32 LE)
// length forms documented in kb/source-fidelity-spec.md § 2.
//
// USAGE:
//   node mcp/test/fixtures/_typedstream-fixture-builder.mjs "the sample contact is Robin; they work in Dayton"
//
// Prints the hex bytes (lowercase, no separator) on one line. The fixture
// SQL inlines that hex via X'...' BLOB literal so npm test does NOT depend
// on Node-side blob building at SQL-load time.
//
// NO new npm deps. Plain Node + Buffer.

import { Buffer } from "node:buffer";

// 13-byte streamtyped magic. Verified byte-exact across 5 real-message
// samples on the operator's chat.db (kb/source-fidelity-spec.md § 2).
const HEADER_MAGIC = Buffer.from([
  0x04, 0x0b, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d,
  0x74, 0x79, 0x70, 0x65, 0x64,
]);

// Version + framing bytes that follow the magic. Constant across all real
// samples: version 0x03e8 LE (1000) + typedstream framing.
const VERSION_FRAMING = Buffer.from([
  0x81, 0xe8, 0x03,
  0x84, 0x01, 0x40,
]);

// Class chain for the canonical text payload. We replicate the exact
// sequence observed on real blobs: NSMutableAttributedString ->
// NSAttributedString -> NSObject (back-ref) -> NSMutableString -> NSString.
const CLASS_CHAIN = Buffer.concat([
  // NSMutableAttributedString
  Buffer.from([0x84, 0x84, 0x84, 0x19]),
  Buffer.from("NSMutableAttributedString\x00", "utf8"),
  // NSAttributedString
  Buffer.from([0x84, 0x84, 0x12]),
  Buffer.from("NSAttributedString\x00", "utf8"),
  // NSObject
  Buffer.from([0x84, 0x84, 0x08]),
  Buffer.from("NSObject\x00", "utf8"),
  // NSMutableString (back-ref byte 0x85 0x92, class def 0x84 0x84 0x84 0x0f)
  Buffer.from([0x85, 0x92, 0x84, 0x84, 0x84, 0x0f]),
  Buffer.from("NSMutableString\x01", "utf8"),
  // NSString
  Buffer.from([0x84, 0x84, 0x08]),
  Buffer.from("NSString\x01", "utf8"),
]);

// START_PATTERN sits AFTER the class chain. Real blobs use the bytes
// 0x95 0x84 0x01 0x2b — the 0x95 + 0x84 are typedstream framing, the
// 0x01 0x2b is the canonical START_PATTERN used by upstream parsers.
const START_PATTERN_PREFIX = Buffer.from([0x95, 0x84, 0x01, 0x2b]);

// END_PATTERN follows the UTF-8 payload. Real blobs use 0x86 0x84.
const END_PATTERN = Buffer.from([0x86, 0x84]);

/**
 * Encode the length-prefix byte(s) per the typedstream spec:
 *   len < 0x81   → 1 byte
 *   len <= 0xFFFF → 0x81 + u16 LE
 *   len > 0xFFFF → 0x82 + u32 LE
 */
function encodeVarLen(len) {
  if (len < 0x81) {
    return Buffer.from([len]);
  }
  if (len <= 0xffff) {
    const b = Buffer.alloc(3);
    b[0] = 0x81;
    b.writeUInt16LE(len, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = 0x82;
  b.writeUInt32LE(len, 1);
  return b;
}

/**
 * Build a synthetic typedstream blob carrying the given plaintext.
 *
 * @param {string} text — the UTF-8 plaintext to embed.
 * @returns {Buffer} the raw typedstream bytes.
 */
export function buildTypedstreamBlob(text) {
  const payload = Buffer.from(text, "utf8");
  const lenBytes = encodeVarLen(payload.length);
  return Buffer.concat([
    HEADER_MAGIC,
    VERSION_FRAMING,
    CLASS_CHAIN,
    START_PATTERN_PREFIX,
    lenBytes,
    payload,
    END_PATTERN,
  ]);
}

/**
 * Build a deliberately-corrupt blob: header magic + class chain + a
 * length byte whose declared length runs past buffer end. parseTypedstream
 * must return null.
 */
export function buildCorruptBlob() {
  // header + framing + START_PATTERN + length 0xFF but only 4 bytes of payload
  return Buffer.concat([
    HEADER_MAGIC,
    VERSION_FRAMING,
    CLASS_CHAIN,
    START_PATTERN_PREFIX,
    Buffer.from([0x81, 0xff, 0xff]), // u16 LE = 65535
    Buffer.from([0x41, 0x42, 0x43, 0x44]), // 4 bytes ≠ declared 65535
  ]);
}

// CLI entry: print hex of the encoded blob for the given argv[2] text.
if (import.meta.url === `file://${process.argv[1]}`) {
  const text = process.argv[2];
  if (!text) {
    process.stderr.write("usage: _typedstream-fixture-builder.mjs <text>\n");
    process.exit(2);
  }
  const blob = buildTypedstreamBlob(text);
  process.stdout.write(blob.toString("hex") + "\n");
}
