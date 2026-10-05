// typedstream-parser.test.mjs — hermetic unit tests for the pure-JS
// typedstream parser at <checkout>/mcp/lib/connectors/_typedstream.js.
//
// HERMETIC: no real chat.db reads. All fixtures are built byte-by-byte in
// this file per kb/source-fidelity-spec.md § 3.
//
// Authoritative spec: kb/source-fidelity-spec.md § 2 (wire format),
// § 3 (test-fixture spec). Source-of-truth target plaintext for the canonical
// fixture: "the sample contact is Robin; they work in Dayton" (48 bytes).
//
// Edge cases covered:
//   F0: golden 48-byte plaintext via single-byte length form
//   F1: truncated buffer → null
//   F2: junk prefix (no streamtyped magic) → null
//   F3: corrupted length running past buffer end → null
//   F4: 0x81 variant — length 200 bytes (covers 129..65535 form)
//   F5: 0x82 variant — length 70000 bytes (covers > 65535 form)
//   F6: empty / null / non-buffer arg
//   F7: oversized blob (over the 1 MiB cap) → null
//   F8: Uint8Array input (not Buffer)
//   F9: utility-fn unit assertions (validateHeader, readVarLen, decodeUtf8)
//   F10: ROWID 7 / 8 / 9 chat.db fixture blobs (re-validates the inlined hex
//        in test/fixtures/imessage-fixture.sql)

import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Production safety snapshot.
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

const {
  parseTypedstream,
  validateHeader,
  findCanonicalStringStart,
  readVarLen,
  decodeUtf8,
  TYPEDSTREAM_MAX_BUFFER_BYTES,
} = await import("../lib/connectors/_typedstream.js");

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// Header constants (mirror what the parser expects).
const HEADER = Buffer.from([
  0x04, 0x0b,
  0x73, 0x74, 0x72, 0x65, 0x61, 0x6d, 0x74, 0x79, 0x70, 0x65, 0x64,
]);

// Build a typedstream blob with the canonical class-chain + START_PATTERN +
// varlen + payload. The class-chain bytes match the spec's hex preamble
// section (§ 3). The fixture intentionally includes the leading 0x95 0x84
// framing observed in real blobs, so the parser is exercised against a
// realistic shape.
function buildBlob(plaintext) {
  const payload = Buffer.from(plaintext, "utf8");
  const len = payload.length;
  // Length encoding.
  let lenBytes;
  if (len < 0x81) {
    lenBytes = Buffer.from([len]);
  } else if (len <= 0xffff) {
    lenBytes = Buffer.alloc(3);
    lenBytes[0] = 0x81;
    lenBytes.writeUInt16LE(len, 1);
  } else {
    lenBytes = Buffer.alloc(5);
    lenBytes[0] = 0x82;
    lenBytes.writeUInt32LE(len, 1);
  }

  // Synthetic class chain (the parser only requires the magic + START_PATTERN;
  // the class chain is essentially scannable framing).
  const classChain = Buffer.concat([
    Buffer.from([0x81, 0xe8, 0x03, 0x84, 0x01, 0x40]), // version + framing
    Buffer.from([0x84, 0x84, 0x84, 0x19]),             // class def hdr
    Buffer.from("NSMutableAttributedString", "utf8"),
    Buffer.from([0x00]),
    Buffer.from([0x84, 0x84, 0x12]),
    Buffer.from("NSAttributedString", "utf8"),
    Buffer.from([0x00]),
    Buffer.from([0x84, 0x84, 0x08]),
    Buffer.from("NSObject", "utf8"),
    Buffer.from([0x00]),
    Buffer.from([0x85, 0x92, 0x84, 0x84, 0x84, 0x0f]),
    Buffer.from("NSMutableString", "utf8"),
    Buffer.from([0x01]),
    Buffer.from([0x84, 0x84, 0x08]),
    Buffer.from("NSString", "utf8"),
    Buffer.from([0x01]),
    // Framing 0x95 0x84 immediately before START_PATTERN, matching reals.
    Buffer.from([0x95, 0x84]),
  ]);

  return Buffer.concat([
    HEADER,
    classChain,
    Buffer.from([0x01, 0x2b]), // START_PATTERN
    lenBytes,
    payload,
    Buffer.from([0x86, 0x84]), // END_PATTERN (informational)
  ]);
}

// ---------------------------------------------------------------------------
// F0 — golden 48-byte single-byte-len form.
// ---------------------------------------------------------------------------
console.log("\n--- F0: golden 48-byte single-byte length form ---");
{
  const text = "the sample contact is Robin; they work in Dayton";
  assert.equal(text.length, 48);
  const blob = buildBlob(text);
  const parsed = parseTypedstream(blob);
  check("F0.a parsed != null", parsed != null,
    `got=${JSON.stringify(parsed)}`);
  check("F0.b parsed.text byte-exact",
    parsed?.text === text,
    `got=${JSON.stringify(parsed?.text)}`);
  check("F0.c parsed.length === 48",
    parsed?.length === 48,
    `got=${parsed?.length}`);
}

// ---------------------------------------------------------------------------
// F1 — truncated buffer.
// ---------------------------------------------------------------------------
console.log("\n--- F1: truncated buffer ---");
{
  const text = "the sample contact is Robin; they work in Dayton";
  const blob = buildBlob(text);
  const truncated = blob.subarray(0, 20);
  const parsed = parseTypedstream(truncated);
  check("F1.a truncated buffer returns null", parsed === null,
    `got=${JSON.stringify(parsed)}`);
}

// ---------------------------------------------------------------------------
// F2 — junk prefix (missing streamtyped magic).
// ---------------------------------------------------------------------------
console.log("\n--- F2: junk prefix (no streamtyped magic) ---");
{
  const junk = Buffer.concat([
    Buffer.from([0xde, 0xad, 0xbe, 0xef]),
    Buffer.from([0x01, 0x2b, 0x05]),
    Buffer.from("hello", "utf8"),
  ]);
  const parsed = parseTypedstream(junk);
  check("F2.a junk prefix returns null", parsed === null,
    `got=${JSON.stringify(parsed)}`);
}

// ---------------------------------------------------------------------------
// F3 — declared length runs past buffer end.
// ---------------------------------------------------------------------------
console.log("\n--- F3: corrupted length running past end ---");
{
  // Build a valid header + START_PATTERN + 0x81 ffff (claims 65535 bytes)
  // followed by only 4 bytes — declared len far exceeds remaining buffer.
  const blob = Buffer.concat([
    HEADER,
    Buffer.from([0x84, 0x01, 0x40]), // minimal framing
    Buffer.from([0x01, 0x2b]),       // START_PATTERN
    Buffer.from([0x81, 0xff, 0xff]), // 0x81 + u16 LE = 65535
    Buffer.from([0x41, 0x42, 0x43, 0x44]),
  ]);
  const parsed = parseTypedstream(blob);
  check("F3.a length > remaining bytes returns null", parsed === null,
    `got=${JSON.stringify(parsed)}`);
}

// ---------------------------------------------------------------------------
// F4 — 0x81 variant (length 200).
// ---------------------------------------------------------------------------
console.log("\n--- F4: 0x81 variant, length 200 ---");
{
  const text = "x".repeat(200);
  const blob = buildBlob(text);
  const parsed = parseTypedstream(blob);
  check("F4.a 200-byte payload decodes", parsed?.text === text,
    `len=${parsed?.length} text-prefix=${parsed?.text?.slice(0, 8)}`);
  check("F4.b length echoes 200", parsed?.length === 200);
}

// ---------------------------------------------------------------------------
// F5 — 0x82 variant (length 70000).
// ---------------------------------------------------------------------------
console.log("\n--- F5: 0x82 variant, length 70000 ---");
{
  const text = "abcdefgh".repeat(70000 / 8);
  assert.equal(text.length, 70000);
  const blob = buildBlob(text);
  const parsed = parseTypedstream(blob);
  check("F5.a 70000-byte payload decodes (length ok)",
    parsed?.length === 70000,
    `got=${parsed?.length}`);
  check("F5.b first 16 bytes match", parsed?.text?.slice(0, 16) === text.slice(0, 16));
  check("F5.c last 16 bytes match", parsed?.text?.slice(-16) === text.slice(-16));
}

// ---------------------------------------------------------------------------
// F6 — null / empty / non-buffer arg.
// ---------------------------------------------------------------------------
console.log("\n--- F6: null / empty / non-buffer arg ---");
{
  check("F6.a null", parseTypedstream(null) === null);
  check("F6.b undefined", parseTypedstream(undefined) === null);
  check("F6.c empty Buffer", parseTypedstream(Buffer.alloc(0)) === null);
  check("F6.d non-buffer (string)", parseTypedstream("not a blob") === null);
  check("F6.e non-buffer (object)", parseTypedstream({}) === null);
  check("F6.f non-buffer (number)", parseTypedstream(42) === null);
}

// ---------------------------------------------------------------------------
// F7 — oversized blob.
// ---------------------------------------------------------------------------
console.log("\n--- F7: blob over TYPEDSTREAM_MAX_BUFFER_BYTES cap ---");
{
  const oversized = Buffer.alloc(TYPEDSTREAM_MAX_BUFFER_BYTES + 1);
  oversized[0] = 0x04;
  oversized[1] = 0x0b;
  oversized.write("streamtyped", 2);
  const parsed = parseTypedstream(oversized);
  check("F7.a oversized blob returns null", parsed === null,
    `cap=${TYPEDSTREAM_MAX_BUFFER_BYTES} got=${JSON.stringify(parsed)}`);
}

// ---------------------------------------------------------------------------
// F8 — Uint8Array input.
// ---------------------------------------------------------------------------
console.log("\n--- F8: Uint8Array input ---");
{
  const text = "hello from Uint8Array";
  const blob = buildBlob(text);
  // Convert to a plain Uint8Array (node:sqlite returns BLOB columns as
  // Uint8Array, not Buffer; we need to handle both).
  const u8 = new Uint8Array(blob);
  const parsed = parseTypedstream(u8);
  check("F8.a Uint8Array input parses", parsed?.text === text,
    `got=${JSON.stringify(parsed?.text)}`);
}

// ---------------------------------------------------------------------------
// F9 — utility-fn unit assertions.
// ---------------------------------------------------------------------------
console.log("\n--- F9: utility-fn unit assertions ---");
{
  // validateHeader — accepts canonical magic, rejects everything else.
  check("F9.a validateHeader on canonical magic returns 13",
    validateHeader(HEADER) === 13);
  check("F9.b validateHeader on too-short buffer returns -1",
    validateHeader(Buffer.alloc(5)) === -1);
  check("F9.c validateHeader on wrong magic returns -1",
    validateHeader(Buffer.from("streamtyped!!", "utf8")) === -1);
  check("F9.d validateHeader on null returns -1",
    validateHeader(null) === -1);

  // findCanonicalStringStart — finds [0x01, 0x2b]. R23: requires the preceding
  // byte to be the documented 0x84 class-def framing tag.
  const buf = Buffer.from([0xaa, 0x84, 0x01, 0x2b, 0xcc]);
  check("F9.e findCanonicalStringStart returns offset past pattern",
    findCanonicalStringStart(buf, 0) === 4);
  check("F9.f findCanonicalStringStart returns -1 on no match",
    findCanonicalStringStart(Buffer.from([0x00, 0x01, 0x00]), 0) === -1);
  // R23 byte-tag defense: matched [0x01, 0x2b] without preceding 0x84 → -1.
  const noTag = Buffer.from([0xaa, 0xbb, 0x01, 0x2b, 0xcc]);
  check("F9.e2 findCanonicalStringStart bails when preceding byte != 0x84",
    findCanonicalStringStart(noTag, 0) === -1);

  // readVarLen — exhaustive sentinel coverage.
  check("F9.g readVarLen single-byte form (0x30 → 48)",
    JSON.stringify(readVarLen(Buffer.from([0x30, 0xff]), 0)) === '{"len":48,"next":1}');
  check("F9.h readVarLen 0x81 form (0x81 0x96 0x00 → 150)",
    JSON.stringify(readVarLen(Buffer.from([0x81, 0x96, 0x00]), 0)) === '{"len":150,"next":3}');
  check("F9.i readVarLen 0x82 form (0x82 0x40 0x9c 0x00 0x00 → 40000)",
    JSON.stringify(readVarLen(Buffer.from([0x82, 0x40, 0x9c, 0x00, 0x00]), 0)) === '{"len":40000,"next":5}');
  check("F9.j readVarLen 0xFF legacy form",
    JSON.stringify(readVarLen(Buffer.from([0xff, 0x10, 0x00, 0x00, 0x00]), 0)) === '{"len":16,"next":5}');
  check("F9.k readVarLen unknown sentinel returns null",
    readVarLen(Buffer.from([0x90, 0x00]), 0) === null);
  check("F9.l readVarLen short-buffer 0x81 returns null",
    readVarLen(Buffer.from([0x81, 0x00]), 0) === null);

  // decodeUtf8 — bounds check + round-trip rejection.
  check("F9.m decodeUtf8 ascii happy path",
    decodeUtf8(Buffer.from("hello", "utf8"), 0, 5) === "hello");
  check("F9.n decodeUtf8 out-of-bounds returns null",
    decodeUtf8(Buffer.from("hi", "utf8"), 0, 10) === null);
  // Invalid UTF-8 (lone continuation byte) → null via round-trip rejection.
  check("F9.o decodeUtf8 invalid utf-8 returns null",
    decodeUtf8(Buffer.from([0x80, 0x80, 0x80]), 0, 3) === null);
}

// ---------------------------------------------------------------------------
// F10 — chat.db fixture blob hex (matches imessage-fixture.sql ROWIDs 7/8/9).
// ---------------------------------------------------------------------------
console.log("\n--- F10: chat.db fixture blob hex matches plaintexts ---");
{
  const blobRowid7 = Buffer.from(
    "040b73747265616d747970656481e803840140848484194e534d757461626c6541747472696275746564537472696e67008484124e5341747472696275746564537472696e67008484084e534f626a6563740085928484840f4e534d757461626c65537472696e67018484084e53537472696e67019584012b307468652073616d706c6520636f6e7461637420697320526f62696e3b207468657920776f726b20696e20446179746f6e8684",
    "hex",
  );
  const parsed7 = parseTypedstream(blobRowid7);
  check("F10.a ROWID 7 blob decodes to 48-byte plaintext",
    parsed7?.text === "the sample contact is Robin; they work in Dayton",
    `got=${JSON.stringify(parsed7?.text)}`);

  const blobRowid8 = Buffer.from(
    "040b73747265616d747970656481e803840140848484194e534d757461626c6541747472696275746564537472696e67008484124e5341747472696275746564537472696e67008484084e534f626a6563740085928484840f4e534d757461626c65537472696e67018484084e53537472696e67019584012b3a6f7574626f756e642074657374206d6573736167652066726f6d207573657220706172746e6572207669612061747472696275746564426f64798684",
    "hex",
  );
  const parsed8 = parseTypedstream(blobRowid8);
  check("F10.b ROWID 8 blob decodes to outbound plaintext",
    parsed8?.text === "outbound test message from user partner via attributedBody",
    `got=${JSON.stringify(parsed8?.text)}`);

  const blobRowid9 = Buffer.from(
    "040b73747265616d747970656481e803840140848484194e534d757461626c6541747472696275746564537472696e67008484124e5341747472696275746564537472696e67008484084e534f626a6563740085928484840f4e534d757461626c65537472696e67018484084e53537472696e67019584012b81ffff41424344",
    "hex",
  );
  const parsed9 = parseTypedstream(blobRowid9);
  check("F10.c ROWID 9 corrupt blob returns null", parsed9 === null,
    `got=${JSON.stringify(parsed9)}`);
}

// ---------------------------------------------------------------------------
// PROD-SAFETY: production memory.jsonl unchanged.
// ---------------------------------------------------------------------------
const prodAfter = snap(PROD_LEDGER);
check("PROD-SAFETY production memory.jsonl mtime+size unchanged", prodBefore === prodAfter,
  `before=${prodBefore} after=${prodAfter}`);

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log(`\nAll typedstream-parser assertions passed.`);
