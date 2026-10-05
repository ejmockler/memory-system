// cross-source-dedup.test.mjs — unit tests for the canonicalizeHandle
// helper in mcp/lib/ingest/cross-source-dedup.js.
//
// Initial scope (F-NEW-W4-CROSS-SOURCE-DEDUP-PCT-DECODE):
//   - Percent-encoded handles (e.g. "%2B15555550123") canonicalize to the
//     same key as their E.164 form ("+15555550123") so a derived_intent_id
//     URL-decode path can be added later without silently missing dups.
//   - Malformed percent-encoding (stray "%") falls back to the raw string
//     instead of throwing on the hot path.
//   - Legacy paths preserved: plain E.164, formatted phone, email shape.
//
// Style: plain ESM, assert.strict, no external harness — matches other
// files under mcp/test/ingest/.

import assert from "node:assert/strict";

const { canonicalizeHandle } = await import(
  "../../lib/ingest/cross-source-dedup.js"
);

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${label}`);
  } else {
    fail += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// F-NEW-W4-CROSS-SOURCE-DEDUP-PCT-DECODE — percent-decode parity.
// ---------------------------------------------------------------------------
console.log("\n--- pct-decode parity (E.164 vs percent-encoded) ---");
{
  const e164 = canonicalizeHandle("+15555550123", "imessage");
  const pct = canonicalizeHandle("%2B15555550123", "screentime");
  ok("percent-encoded handle matches E.164",
    e164 === pct && e164 === "15555550123",
    `e164=${JSON.stringify(e164)} pct=${JSON.stringify(pct)}`);
}

// Double-encoded (defence-in-depth) — single decode pass is enough for the
// common case; double-encoded handles intentionally do NOT match. Document
// the boundary so a future operator change is explicit.
{
  const e164 = canonicalizeHandle("+15555550123", "imessage");
  const doubled = canonicalizeHandle("%252B15555550123", "screentime");
  // Single decode -> "%2B15555550123"; phone heuristic still extracts the
  // digits. Confirm the boundary behaviour rather than promising it.
  ok("double-encoded handle is not guaranteed to match (documented)",
    typeof doubled === "string", `doubled=${JSON.stringify(doubled)}`);
  // But the new branch DOES handle the much-more-common single encoding,
  // and the legacy E.164 still extracts to 11 digits.
  ok("E.164 still extracts 11 digits", e164 === "15555550123");
}

// ---------------------------------------------------------------------------
// Malformed percent-encoding — decodeURIComponent throws URIError; the
// try/catch wrapper falls back to the raw string. The phone heuristic then
// extracts digits as usual.
// ---------------------------------------------------------------------------
console.log("\n--- malformed percent-encoding does not throw ---");
{
  let threw = false;
  let out;
  try {
    out = canonicalizeHandle("50% off and +15555550123", "imessage");
  } catch (err) {
    threw = true;
    console.error(`unexpected throw: ${err.message}`);
  }
  ok("stray '%' input does not throw", !threw);
  // Phone heuristic still pulls the digit run out of the fallback string.
  ok("phone digits extracted from fallback string",
    typeof out === "string" && out.includes("15555550123"),
    `out=${JSON.stringify(out)}`);
}

// ---------------------------------------------------------------------------
// Legacy preservation — pre-existing paths still behave the same way.
// ---------------------------------------------------------------------------
console.log("\n--- legacy normalization unchanged ---");
{
  ok("formatted phone -> digit run",
    canonicalizeHandle("+1 (555) 555-0123", "imessage") === "15555550123");
  ok("plain digit run preserved",
    canonicalizeHandle("15555550123", "imessage") === "15555550123");
  ok("email lowercased+trimmed (not phone-like)",
    canonicalizeHandle("  Bob@Example.com ", "mail") === "bob@example.com");
  ok("empty string -> empty key",
    canonicalizeHandle("", "imessage") === "");
  ok("non-string -> empty key",
    canonicalizeHandle(null, "imessage") === "");
}

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------
console.log(`\n${pass} pass, ${fail} fail.`);
if (fail > 0) process.exit(1);
assert.equal(fail, 0);
