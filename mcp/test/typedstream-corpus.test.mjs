// typedstream-corpus.test.mjs — hermetic empirical-failure-mode coverage for
// the R23 defensive guard in mcp/lib/connectors/_typedstream.js.
//
// HERMETIC: no real chat.db reads. All blobs are hand-crafted byte-by-byte.
//
// Companion to typedstream-parser.test.mjs. Where that file pins the WIRE
// FORMAT (header, varlen, UTF-8 decode), THIS file pins the R23
// FRAMING-TAG GUARD added by the round-23 brutalist DOWNGRADE remediation.
//
// Reference: /tmp/claude-501/memory-system-tasks/reviews/r23/audit-typedstream-corpus.md
//
// Phase A3 empirical findings drove this surface:
//   - 14,891 / 14,891 successful decodes have 0x84 immediately before the
//     canonical [0x01, 0x2b].
//   - 0x95 (back-reference) is the documented alternative framing tag.
//   - 911 / 14,891 (6.1%) blobs carry SECONDARY [0x01, 0x2b] occurrences
//     downstream of the canonical hit, inside embedded NSAttributeInfo
//     dicts; these secondary hits are preceded by ASCII content bytes
//     (0x22, 0x49, 0x28, ...). The guard must reject them.
//   - The CURRENT corpus does NOT exhibit a "first hit unframed, second hit
//     framed" pattern — but a defensive parser must still handle it.
//
// Coverage matrix:
//   C1  0x84-framed canonical NSString               → SUCCESS
//   C2  0x95-framed canonical NSString               → SUCCESS
//   C3  [0x01,0x2b] at buffer index 0 (no prev)      → NULL
//   C4  ASCII-preceded [0x01,0x2b], no framed hit    → NULL
//   C5  bug-bait first, framed second (walk-fwd)    → SUCCESS, suspicious=1
//   C6  emoji round-trip (multi-byte UTF-8)         → SUCCESS, bytes intact
//   C7  primary framed + secondary ASCII-preceded   → SUCCESS, no rejection
//                                                     count for primary
//   C8  ALL candidates are bug-bait pretenders      → NULL, suspicious=N
//   C9  framed [0x01,0x2b] then bogus varlen        → NULL, varlen_invalid=1
//   C10 telemetry: getDecodeStats / resetDecodeStats round-trip
//
// Adversarial blobs (rejection required):
//   A_C3, A_C4, A_C8.

import { homedir } from "node:os";
import { statSync } from "node:fs";
import { join } from "node:path";

const PROD_LEDGER = join(homedir(), "memory-system", "ledgers", "memory.jsonl");
let prodBefore = null;
try {
  const st = statSync(PROD_LEDGER);
  prodBefore = { mtimeMs: st.mtimeMs, size: st.size };
} catch {}

const {
  parseTypedstream,
  findCanonicalStringStart,
  getDecodeStats,
  resetDecodeStats,
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

// 13-byte streamtyped magic.
const HEADER = Buffer.from([
  0x04, 0x0b,
  0x73, 0x74, 0x72, 0x65, 0x61, 0x6d, 0x74, 0x79, 0x70, 0x65, 0x64,
]);

// Single-byte varlen encoder (sufficient for all corpus payloads <128 bytes).
function shortVarLen(n) {
  if (n < 0x81) return Buffer.from([n]);
  // 0x81 + u16 LE.
  const out = Buffer.alloc(3);
  out[0] = 0x81;
  out.writeUInt16LE(n, 1);
  return out;
}

// Build a blob whose canonical NSString is preceded by `framingTag`
// (0x84 in production, 0x95 admitted by spec, anything else = adversarial).
function buildBlobWithFraming(text, framingTag, opts = {}) {
  const payload = Buffer.from(text, "utf8");
  const parts = [HEADER];
  // Minimal junk class chain so the [0x01,0x2b] hit is not at index 0.
  parts.push(Buffer.from([0x81, 0xe8, 0x03])); // version
  parts.push(Buffer.from("NSString", "utf8"));
  parts.push(Buffer.from([0x00]));
  if (opts.prefixDecoyAscii) {
    // Insert an ASCII-preceded [0x01,0x2b] BEFORE the legit framed one.
    parts.push(Buffer.from([0x22, 0x01, 0x2b, 0x05, 0xff, 0xff]));
  }
  parts.push(Buffer.from([framingTag])); // the framing tag in question
  parts.push(Buffer.from([0x01, 0x2b])); // START_PATTERN
  parts.push(shortVarLen(payload.length));
  parts.push(payload);
  if (opts.suffixDictionary) {
    // Append an embedded NSAttributeInfo dict with ASCII-preceded [0x01,0x2b]
    // (the real-world 911/14891 pattern).
    parts.push(Buffer.from([
      0x86, 0x84, // END_PATTERN
      0x22, 0x5f, 0x5f, 0x6b, 0x49, 0x4d, 0x4d, 0x65, 0x73, // "__kIMMes
      0x01, 0x2b, // adversarial second hit — preceded by ASCII 0x73 ("s")
      0x10, 0x41, 0x42, 0x43,
    ]));
  }
  return Buffer.concat(parts);
}

// Adversarial: ALL candidate [0x01,0x2b] hits are preceded by non-framing bytes.
function buildAllPretenderBlob(text) {
  const payload = Buffer.from(text, "utf8");
  return Buffer.concat([
    HEADER,
    Buffer.from([0x81, 0xe8, 0x03]),
    Buffer.from("NSString", "utf8"),
    Buffer.from([0x00]),
    Buffer.from([0x22, 0x01, 0x2b, 0x05]), // pretender #1 preceded by 0x22
    Buffer.from([0x49, 0x01, 0x2b, 0x05]), // pretender #2 preceded by 0x49
    Buffer.from([0x28, 0x01, 0x2b, 0x05]), // pretender #3 preceded by 0x28
    Buffer.from([0x33]),                   // pretender #4 preceded by 0x33
    Buffer.from([0x01, 0x2b]),
    shortVarLen(payload.length),
    payload,
  ]);
}

// ---------------------------------------------------------------------------
// C1 — canonical 0x84-framed NSString. Success.
// ---------------------------------------------------------------------------
console.log("\n--- C1: 0x84-framed canonical NSString ---");
{
  resetDecodeStats();
  const text = "hello from 0x84 framing";
  const blob = buildBlobWithFraming(text, 0x84);
  const out = parseTypedstream(blob);
  check("C1.a text matches", out?.text === text, `got=${JSON.stringify(out?.text)}`);
  const s = getDecodeStats();
  check("C1.b stats.attempts === 1", s.attempts === 1, `got=${s.attempts}`);
  check("C1.c stats.successes === 1", s.successes === 1, `got=${s.successes}`);
  check("C1.d stats.suspicious_rejected === 0",
    s.suspicious_rejected === 0, `got=${s.suspicious_rejected}`);
}

// ---------------------------------------------------------------------------
// C2 — 0x95-framed canonical NSString (back-reference tag). Success.
// ---------------------------------------------------------------------------
console.log("\n--- C2: 0x95-framed (back-reference) canonical NSString ---");
{
  resetDecodeStats();
  const text = "back-reference framing should also be accepted";
  const blob = buildBlobWithFraming(text, 0x95);
  const out = parseTypedstream(blob);
  check("C2.a text matches", out?.text === text, `got=${JSON.stringify(out?.text)}`);
  const s = getDecodeStats();
  check("C2.b stats.successes === 1", s.successes === 1, `got=${s.successes}`);
  check("C2.c stats.suspicious_rejected === 0",
    s.suspicious_rejected === 0, `got=${s.suspicious_rejected}`);
}

// ---------------------------------------------------------------------------
// C3 (ADVERSARIAL) — [0x01,0x2b] appears at buffer index 0 of the search
// window (immediately after header, no preceding byte). Reject.
// ---------------------------------------------------------------------------
console.log("\n--- C3 (adversarial): [0x01,0x2b] at search-window edge ---");
{
  resetDecodeStats();
  // Build a buffer where the very first byte AFTER the header is 0x01 0x2b —
  // no preceding byte exists inside the search window.
  const text = "shouldnotdecode";
  const payload = Buffer.from(text, "utf8");
  const blob = Buffer.concat([
    HEADER,
    Buffer.from([0x01, 0x2b]), // at offset = HEADER.length, prev byte == HEADER end (0x64 'd')
    shortVarLen(payload.length),
    payload,
  ]);
  // The byte immediately before [0x01,0x2b] is HEADER's last byte 0x64 ('d'),
  // NOT a framing tag. Guard must reject and return null.
  const out = parseTypedstream(blob);
  check("C3.a no-framing-tag immediately after header → null", out === null,
    `got=${JSON.stringify(out)}`);
  const s = getDecodeStats();
  check("C3.b stats.suspicious_rejected >= 1",
    s.suspicious_rejected >= 1, `got=${s.suspicious_rejected}`);
  check("C3.c stats.start_not_found === 1",
    s.start_not_found === 1, `got=${s.start_not_found}`);
}

// ---------------------------------------------------------------------------
// C4 (ADVERSARIAL) — bug-bait: every candidate [0x01,0x2b] is preceded by an
// ASCII content byte from an embedded NSAttributeInfo dict, never by a
// framing tag. Reject.
// ---------------------------------------------------------------------------
console.log("\n--- C4 (adversarial): all candidates ASCII-preceded ---");
{
  resetDecodeStats();
  const blob = buildAllPretenderBlob("ignored payload");
  const out = parseTypedstream(blob);
  check("C4.a all pretenders → null", out === null, `got=${JSON.stringify(out)}`);
  const s = getDecodeStats();
  check("C4.b suspicious_rejected >= 3 (3 pretenders + maybe trailing edge)",
    s.suspicious_rejected >= 3, `got=${s.suspicious_rejected}`);
  check("C4.c start_not_found === 1",
    s.start_not_found === 1, `got=${s.start_not_found}`);
  check("C4.d successes === 0", s.successes === 0, `got=${s.successes}`);
}

// ---------------------------------------------------------------------------
// C5 — WALK-FORWARD: first [0x01,0x2b] is bug-bait, second is properly
// 0x84-framed. Parser must skip the first and decode the second.
// ---------------------------------------------------------------------------
console.log("\n--- C5: walk-forward past one bug-bait to framed hit ---");
{
  resetDecodeStats();
  const text = "found me on the second pass";
  const blob = buildBlobWithFraming(text, 0x84, { prefixDecoyAscii: true });
  const out = parseTypedstream(blob);
  check("C5.a text matches", out?.text === text, `got=${JSON.stringify(out?.text)}`);
  const s = getDecodeStats();
  check("C5.b suspicious_rejected === 1",
    s.suspicious_rejected === 1, `got=${s.suspicious_rejected}`);
  check("C5.c successes === 1", s.successes === 1, `got=${s.successes}`);
}

// ---------------------------------------------------------------------------
// C6 — emoji round-trip on the 0x84 path. Bytes must survive intact.
// ---------------------------------------------------------------------------
console.log("\n--- C6: emoji round-trip on 0x84 path ---");
{
  resetDecodeStats();
  const text = "the sample contact is Robin \u{1F496} they work in Dayton";
  const blob = buildBlobWithFraming(text, 0x84);
  const out = parseTypedstream(blob);
  check("C6.a text round-trip byte-exact", out?.text === text,
    `got=${JSON.stringify(out?.text)}`);
  const payloadBytes = Buffer.from(text, "utf8").length;
  check("C6.b length === UTF-8 byte count",
    out?.length === payloadBytes, `got=${out?.length} expected=${payloadBytes}`);
}

// ---------------------------------------------------------------------------
// C7 — primary 0x84-framed hit followed by a secondary ASCII-preceded
// [0x01,0x2b] inside an embedded dict (the 911 / 14,891 real-world shape).
// Parser must NOT rescan downstream after a successful decode — so the
// suspicious counter remains 0 for the canonical case.
// ---------------------------------------------------------------------------
console.log("\n--- C7: primary framed + downstream dict pretender ---");
{
  resetDecodeStats();
  const text = "canonical body with embedded NSAttributeInfo dict";
  const blob = buildBlobWithFraming(text, 0x84, { suffixDictionary: true });
  const out = parseTypedstream(blob);
  check("C7.a primary text decoded", out?.text === text,
    `got=${JSON.stringify(out?.text)}`);
  const s = getDecodeStats();
  check("C7.b downstream pretender NOT counted (primary wins first)",
    s.suspicious_rejected === 0, `got=${s.suspicious_rejected}`);
  check("C7.c successes === 1", s.successes === 1, `got=${s.successes}`);
}

// ---------------------------------------------------------------------------
// C8 (ADVERSARIAL) — N=5 candidates, ALL pretenders, none framed. Reject.
// ---------------------------------------------------------------------------
console.log("\n--- C8 (adversarial): five pretenders, no framing ---");
{
  resetDecodeStats();
  // Five [0x01,0x2b] hits, each preceded by an ASCII content byte.
  const blob = Buffer.concat([
    HEADER,
    Buffer.from("NSString", "utf8"),
    Buffer.from([0x22, 0x01, 0x2b]),
    Buffer.from([0x49, 0x01, 0x2b]),
    Buffer.from([0x28, 0x01, 0x2b]),
    Buffer.from([0x33, 0x01, 0x2b]),
    Buffer.from([0x77, 0x01, 0x2b]),
    Buffer.from([0x10, 0x41, 0x42, 0x43]),
  ]);
  const out = parseTypedstream(blob);
  check("C8.a all-pretenders → null", out === null, `got=${JSON.stringify(out)}`);
  const s = getDecodeStats();
  check("C8.b suspicious_rejected >= 5", s.suspicious_rejected >= 5,
    `got=${s.suspicious_rejected}`);
}

// ---------------------------------------------------------------------------
// C9 — framed [0x01,0x2b] but bogus varlen sentinel after. Reject via
// varlen_invalid bucket (not start_not_found).
// ---------------------------------------------------------------------------
console.log("\n--- C9: framed hit, invalid varlen sentinel ---");
{
  resetDecodeStats();
  const blob = Buffer.concat([
    HEADER,
    Buffer.from("NSString", "utf8"),
    Buffer.from([0x00]),
    Buffer.from([0x84, 0x01, 0x2b]), // framed
    Buffer.from([0x90, 0x00, 0x00]), // 0x90 is an unknown sentinel
  ]);
  const out = parseTypedstream(blob);
  check("C9.a invalid varlen → null", out === null, `got=${JSON.stringify(out)}`);
  const s = getDecodeStats();
  check("C9.b varlen_invalid === 1", s.varlen_invalid === 1,
    `got=${s.varlen_invalid}`);
  check("C9.c start_not_found === 0", s.start_not_found === 0,
    `got=${s.start_not_found}`);
}

// ---------------------------------------------------------------------------
// C10 — telemetry helpers round-trip.
// ---------------------------------------------------------------------------
console.log("\n--- C10: getDecodeStats / resetDecodeStats round-trip ---");
{
  resetDecodeStats();
  const s0 = getDecodeStats();
  check("C10.a after reset all counters zero",
    Object.values(s0).every((v) => v === 0),
    `got=${JSON.stringify(s0)}`);
  // Mutate via a real call.
  parseTypedstream(buildBlobWithFraming("ping", 0x84));
  const s1 = getDecodeStats();
  check("C10.b after one success attempts === successes === 1",
    s1.attempts === 1 && s1.successes === 1,
    `got=${JSON.stringify(s1)}`);
  // getDecodeStats returns a COPY — mutating must not leak.
  s1.attempts = 9999;
  const s2 = getDecodeStats();
  check("C10.c getDecodeStats returns a defensive copy",
    s2.attempts === 1, `got=${s2.attempts}`);
  resetDecodeStats();
  const s3 = getDecodeStats();
  check("C10.d resetDecodeStats zeroes all buckets",
    Object.values(s3).every((v) => v === 0),
    `got=${JSON.stringify(s3)}`);
}

// ---------------------------------------------------------------------------
// findCanonicalStringStart unit assertions for the framing-tag walk-forward
// (extra coverage beyond F9.e2 in the parser test).
// ---------------------------------------------------------------------------
console.log("\n--- C11: findCanonicalStringStart walk-forward unit ---");
{
  // ASCII pretender at index 2, framed 0x84 hit at index 6.
  const buf = Buffer.from([
    0xaa, 0x22, 0x01, 0x2b, 0xff, 0x84, 0x01, 0x2b, 0xcc,
  ]);
  // First hit: [0x01,0x2b] at idx=2, prev=0x22 → rejected, walk to idx=6.
  // Second hit: [0x01,0x2b] at idx=6, prev=0x84 → accept, return 6+2 = 8.
  const got = findCanonicalStringStart(buf, 0);
  check("C11.a walk-forward returns offset after framed hit", got === 8,
    `got=${got}`);
  // Buffer with only the pretender — returns -1.
  const onlyPretender = Buffer.from([0xaa, 0x22, 0x01, 0x2b, 0xff]);
  check("C11.b only pretender → -1",
    findCanonicalStringStart(onlyPretender, 0) === -1,
    `got=${findCanonicalStringStart(onlyPretender, 0)}`);
  // Framed by 0x95.
  const framed95 = Buffer.from([0xaa, 0x95, 0x01, 0x2b, 0xcc]);
  check("C11.c 0x95-framed hit accepted",
    findCanonicalStringStart(framed95, 0) === 4,
    `got=${findCanonicalStringStart(framed95, 0)}`);
}

// ---------------------------------------------------------------------------
// PROD-SAFETY: production memory.jsonl unchanged.
// ---------------------------------------------------------------------------
let prodAfter = null;
try {
  const st = statSync(PROD_LEDGER);
  prodAfter = { mtimeMs: st.mtimeMs, size: st.size };
} catch {}
if (prodBefore != null && prodAfter != null) {
  const intact = prodBefore.mtimeMs === prodAfter.mtimeMs &&
    prodBefore.size === prodAfter.size;
  check("PROD-SAFETY production memory.jsonl mtime+size unchanged", intact,
    `before=${JSON.stringify(prodBefore)} after=${JSON.stringify(prodAfter)}`);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log(`\nAll typedstream-corpus assertions passed.`);
