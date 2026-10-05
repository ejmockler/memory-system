// reconciliation-stringcap.test.mjs — s2-reconciliation-latent.
//
// WHAT THIS PINS
//   `lib/synthesis/reconciliation.js` was the last module in lib/synthesis/
//   whose ledger fallback read the WHOLE file into one JS string. Node/V8's
//   max string length is 536,870,888 bytes and the live memory.jsonl is well
//   past 3 GB, so that read throws ERR_STRING_TOO_LONG — and the bare catch
//   turned "unreadable" into "empty".
//
//   IMPORTANT / TRUTHFUL FRAMING: this was a LATENT landmine, not a live
//   outage. The only production caller (reconstruction-emitter.js:1310-1313,
//   commit 8c991806, 2026-07-08) always supplies a derivationGraph whose
//   `byId` is a Map, and detectContradictions short-circuits on that before
//   ever touching ledgerPath. Nothing has been "running against zero rows".
//   What was genuinely broken is the DECLARED-BUT-UNREACHABLE error contract:
//   `DETECT_LEDGER_UNREADABLE` could never be produced because the scan could
//   never report a failure.
//
// COVERAGE
//   (a) unreadable FILE            → DETECT_LEDGER_UNREADABLE + reason
//   (b) unreadable PARENT DIR      → DETECT_LEDGER_UNREADABLE (the existsSync
//                                    conflation _ledger-stream.js:118-127 (B1c3)
//                                    documents as removed elsewhere)
//   (c) missing ledger (ENOENT)    → stays benign, code "OK"  [no-regression]
//   (d) multi-chunk + UTF-8 seam + post-seam authority row + torn tail
//   (e) module-local mechanical guard against the whole-file-read pattern
//
// NOTE ON (e): this is only the MODULE-LOCAL backstop. The repo-wide,
// comment-aware source scan (which must not trip on prose) is owned by
// s1-stringcap-guard; this test deliberately does not duplicate its tokenizer.
//
// Hermetic env: MEMORY_ROOT etc set BEFORE any dynamic import touches
// config.js. Nothing here ever references memoryLedgerPath() or the real
// production ledger.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// -----------------------------------------------------------------------------
// Hermetic env — MUST be set BEFORE any dynamic import touches config.js.
// -----------------------------------------------------------------------------

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-reconcile-stringcap-"));
process.env.MEMORY_ROOT = TMP_ROOT;
process.env.POLICY_BASE_DIR = join(TMP_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TMP_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TMP_ROOT, "ledgers");
process.env.HOOKS_BASE_DIR = join(TMP_ROOT, "hooks");
process.env.DAEMONS_BASE_DIR = join(TMP_ROOT, "daemons");

for (const d of [
  process.env.POLICY_BASE_DIR,
  process.env.STORAGE_BASE_DIR,
  process.env.LEDGERS_BASE_DIR,
  process.env.HOOKS_BASE_DIR,
  process.env.DAEMONS_BASE_DIR,
  join(process.env.STORAGE_BASE_DIR, "sources"),
]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}

process.on("exit", () => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
});

// -----------------------------------------------------------------------------
// Dynamic import (post-env).
// -----------------------------------------------------------------------------

const reconcileMod = await import("../../lib/synthesis/reconciliation.js");
const { detectContradictions, __internal } = reconcileMod;

// -----------------------------------------------------------------------------
// (a) Unreadable FILE → DETECT_LEDGER_UNREADABLE
// -----------------------------------------------------------------------------

test("stringcap: unreadable ledger FILE → DETECT_LEDGER_UNREADABLE, not silent-empty", async () => {
  // chmod tricks don't bite when running as root (root reads anything).
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return; // environmental skip — cannot make a file unreadable for root
  }
  const deadPath = join(TMP_ROOT, "unreadable-ledger.jsonl");
  writeFileSync(deadPath, '{"id":"fact_hidden","kind":"fact"}\n', { mode: 0o600 });
  chmodSync(deadPath, 0o000);
  try {
    const detect = await detectContradictions({
      newReconstruction: { content: "x", features: { entities: [] } },
      parents: [],
      ledgerPath: deadPath,
    });
    assert.equal(
      detect.detection_evidence.code,
      "DETECT_LEDGER_UNREADABLE",
      "an EACCES ledger must NOT be conflated with an empty ledger",
    );
    assert.equal(detect.detection_evidence.reason, "ledger_unreadable");
    assert.equal(detect.contradicting.length, 0);
  } finally {
    // Mandatory: a 0o000 leftover makes the exit-hook rmSync(TMP_ROOT) fail.
    try { chmodSync(deadPath, 0o600); } catch {}
    try { rmSync(deadPath, { force: true }); } catch {}
  }
});

// -----------------------------------------------------------------------------
// (b) Unreadable PARENT DIRECTORY → DETECT_LEDGER_UNREADABLE
// -----------------------------------------------------------------------------

test("stringcap: unreadable PARENT DIR → DETECT_LEDGER_UNREADABLE (B1c3 existsSync conflation)", async () => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return; // environmental skip
  }
  const sub = join(TMP_ROOT, "locked-dir");
  mkdirSync(sub, { recursive: true, mode: 0o700 });
  const inner = join(sub, "memory.jsonl");
  writeFileSync(inner, '{"id":"fact_behind_wall","kind":"fact"}\n', { mode: 0o600 });
  chmodSync(sub, 0o000);
  try {
    const detect = await detectContradictions({
      newReconstruction: { content: "x", features: { entities: [] } },
      parents: [],
      ledgerPath: inner,
    });
    // existsSync() returns FALSE for a file behind an EACCES parent — the exact
    // "unreadable path looks missing" conflation _ledger-stream.js:118-127
    // classifies away via the openSync errno.
    assert.equal(
      detect.detection_evidence.code,
      "DETECT_LEDGER_UNREADABLE",
      "a ledger that EXISTS behind an EACCES parent dir must not read as empty",
    );
    assert.equal(detect.detection_evidence.reason, "ledger_unreadable");
    assert.equal(detect.contradicting.length, 0);
  } finally {
    // Mandatory: restore or the exit-hook rmSync(TMP_ROOT) leaks a 0o000 tree.
    try { chmodSync(sub, 0o700); } catch {}
    try { rmSync(sub, { recursive: true, force: true }); } catch {}
  }
});

// -----------------------------------------------------------------------------
// (c) Missing ledger (ENOENT) stays benign — NO-REGRESSION
// -----------------------------------------------------------------------------

test("stringcap: missing ledger (ENOENT) stays benign → code OK, no contradictions", async () => {
  // Pins reconciliation.test.mjs:519-529. ENOENT must NEVER be promoted to
  // DETECT_LEDGER_UNREADABLE — per _ledger-stream.js:141-146 a genuinely
  // missing ledger keeps readError === null.
  const badPath = join(TMP_ROOT, "does-not-exist-dir", "memory.jsonl");
  const detect = await detectContradictions({
    newReconstruction: { content: "x", features: { entities: [] } },
    parents: ["fact_missing"],
    ledgerPath: badPath,
  });
  assert.equal(detect.contradicting.length, 0);
  assert.equal(detect.detection_evidence.code, "OK");
});

// -----------------------------------------------------------------------------
// (d) Multi-chunk ledger: UTF-8 seam, post-seam authority row, torn tail
// -----------------------------------------------------------------------------

test("stringcap: multi-chunk ledger parses byte-exactly across the 64KiB seam; post-seam authority row is reached", async () => {
  const ledgerPath = join(process.env.LEDGERS_BASE_DIR, "seam-ledger.jsonl");

  // Chunk size in _ledger-stream.js is 64 KiB (65,536 bytes). Place a 2-byte
  // "é" so its FIRST byte sits at absolute offset 65,535 — the last byte of
  // chunk 1 — forcing the codepoint to straddle the chunk seam.
  const seamPrefix =
    '{"id":"fact_seam","ts":"2026-05-31T00:01:00Z","kind":"fact","source":"test-fixture","content":"';
  const seamContent = "é-seam-content-survives-chunk-boundary";
  const seamLine = seamPrefix + seamContent + '"}\n';
  const padHead =
    '{"id":"fact_pad","ts":"2026-05-31T00:00:00Z","kind":"fact","source":"test-fixture","content":"';
  const padTail = '"}\n';
  const line1TargetBytes = 65535 - Buffer.byteLength(seamPrefix, "utf8");
  const padLen =
    line1TargetBytes -
    Buffer.byteLength(padHead, "utf8") -
    Buffer.byteLength(padTail, "utf8");
  assert.ok(padLen > 0, "pad computation sanity");
  const line1 = padHead + "x".repeat(padLen) + padTail;
  assert.equal(
    Buffer.byteLength(line1 + seamPrefix, "utf8"),
    65535,
    "é first byte must land on the last byte of the first 64KiB chunk",
  );

  // Bulk rows (facts — never authority candidates) so later seams also cross
  // non-ASCII bytes.
  const BULK = 3000;
  let bulk = "";
  for (let i = 0; i < BULK; i++) {
    bulk +=
      JSON.stringify({
        id: `fact_bulk_${String(i).padStart(4, "0")}`,
        ts: "2026-05-31T00:02:00Z",
        kind: "fact",
        source: "test-fixture",
        content: `bulk row ${i} — naïve café résumé Zürich 東京 ${i}`,
      }) + "\n";
  }

  // The ONLY qualifying exclude policy, appended AFTER the seam so it is
  // reachable only if the streamer read past chunk 1.
  const authorityRow = {
    id: "policy_seam_authority",
    ts: "2026-05-31T00:03:00Z",
    kind: "policy",
    policy_kind: "exclude",
    confidence: 0.95, // > RECONCILE_CAPS.AUTHORITY_CONFIDENCE_GATE (0.85)
    rescinded_at: null,
    features: { entities: [{ canonical_id: "seam-entity" }] },
  };

  writeFileSync(
    ledgerPath,
    line1 + seamLine + bulk + JSON.stringify(authorityRow) + "\n",
    { mode: 0o600 },
  );

  // --- byte-exact round-trip across the seam --------------------------------
  const rows = __internal.scanLedger(ledgerPath);
  assert.equal(rows.length, 2 + BULK + 1, "every synthetic row must parse");
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.equal(
    byId.get("fact_seam").content,
    seamContent,
    "multi-byte codepoint straddling the 64KiB chunk seam must round-trip exactly (no U+FFFD)",
  );
  assert.equal(byId.get("fact_pad").content, "x".repeat(padLen));
  assert.equal(
    byId.get("fact_bulk_2999").content,
    "bulk row 2999 — naïve café résumé Zürich 東京 2999",
  );

  // --- the post-seam authority row is actually reached ----------------------
  const detect = await detectContradictions({
    newReconstruction: {
      content: "Proposal touching the seam entity.",
      features: { entities: [{ canonical_id: "seam-entity" }] },
      scope: "conversation_local",
      provenance: { agent_id: "claude-code:seam", conversation_id: "seam", confidence: 0.9 },
    },
    parents: [],
    ledgerPath,
  });
  assert.equal(detect.detection_evidence.code, "OK");
  assert.equal(
    detect.detection_evidence.authority_hits.length,
    1,
    "the exclude policy sits past the first 64KiB chunk — reachable only via a full streamed scan",
  );
  assert.equal(detect.detection_evidence.authority_hits[0].candidate_id, "policy_seam_authority");

  // --- torn tail (daemon mid-append) is tolerated, not fatal ----------------
  appendFileSync(ledgerPath, '{"id":"fact_torn","kind":"fa', { mode: 0o600 });
  const rows2 = __internal.scanLedger(ledgerPath);
  assert.equal(rows2.length, 2 + BULK + 1, "torn trailing line is skipped, not fatal");
});

// -----------------------------------------------------------------------------
// (e) Module-local mechanical guard — the `ledger`-track class gate
// -----------------------------------------------------------------------------

test("stringcap: reconciliation.js source carries no whole-file ledger read", () => {
  const src = readFileSync(
    new URL("../../lib/synthesis/reconciliation.js", import.meta.url),
    "utf8",
  );
  assert.ok(
    !/\breadFileSync\b/.test(src),
    "reconciliation.js must never whole-file-read the ledger — ERR_STRING_TOO_LONG class, see _ledger-stream.js streamLedgerLines",
  );
  assert.ok(
    !/\bexistsSync\b/.test(src),
    "reconciliation.js must not existsSync-gate the ledger — B1c3 conflates EACCES/ELOOP/ENOTDIR with missing; the openSync errno in _ledger-stream.js streamLedgerLines is the discriminator",
  );
  assert.match(src, /streamLedgerLines/);
});
