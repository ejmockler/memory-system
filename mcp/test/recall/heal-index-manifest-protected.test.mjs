// heal-index-manifest-protected.test.mjs — S3g allowlist-drift regression.
//
// WHAT THIS PINS: the belt-and-suspenders PROTECTED allowlist in
// scripts/heal-index-manifest.mjs (the files the heal script must NEVER
// unlink) must cover the ACTUAL WAL-family filenames as defined by their
// index-wal.js constants — never a hand-typed literal that can silently
// drift from the real name.
//
// THE BUG (S3g, verified live 2026-07-16): PROTECTED carried the literal
// "index-wal.applied-cursor.json", but the real applied-cursor file is
// WAL_CURSOR_FILE = "index-wal.applied.json" (index-wal.js). The literal
// matched NOTHING on disk, so the intended hard stop protecting the live
// applied-cursor from deletion was INERT. This suite fails RED against that
// pre-fix source and stays green once PROTECTED derives its WAL names from
// the index-wal.js constants.
//
// SELF-EVIDENTLY NON-VACUOUS: every WAL assertion reads the value from the
// index-wal.js constant (single source of truth) and asserts membership, so
// a regression in EITHER the constant or the allowlist trips it.
//
// Hermetic: imports the PROTECTED Set only. The heal script's probe/heal
// body is guarded behind import.meta.main, so importing it triggers ZERO
// probe/heal I/O — no production memory.jsonl, indices, or WAL bytes are
// read, written, or mtime-touched.

import test from "node:test";
import assert from "node:assert/strict";

import { PROTECTED } from "../../scripts/heal-index-manifest.mjs";
import {
  WAL_FILE,
  WAL_CURSOR_FILE,
  WAL_QUARANTINE_NOTE_FILE,
  WAL_CORRUPT_STRIKE_FILE,
} from "../../lib/recall/index-wal.js";

test("PROTECTED is an importable Set (guarded main() ran no probe/heal I/O)", () => {
  assert.ok(
    PROTECTED instanceof Set,
    "heal-index-manifest.mjs must export PROTECTED as a Set that imports cleanly",
  );
});

test("PROTECTED covers the live WAL applied-cursor by its index-wal.js constant", () => {
  // The load-bearing assertion. Pre-fix the allowlist held the wrong literal
  // "index-wal.applied-cursor.json", so this was false and the cursor was
  // unprotected.
  assert.ok(
    PROTECTED.has(WAL_CURSOR_FILE),
    `PROTECTED must contain WAL_CURSOR_FILE ("${WAL_CURSOR_FILE}") so the live ` +
      "applied-cursor can never be unlinked by a future heal path",
  );
  // And the stale literal must be gone — its presence would prove a
  // hand-typed name is still in the allowlist.
  assert.ok(
    !PROTECTED.has("index-wal.applied-cursor.json"),
    'the stale literal "index-wal.applied-cursor.json" (never a real filename) ' +
      "must not appear in PROTECTED",
  );
});

test("PROTECTED covers every WAL-family file by its index-wal.js constant", () => {
  for (const [name, val] of [
    ["WAL_FILE", WAL_FILE],
    ["WAL_CURSOR_FILE", WAL_CURSOR_FILE],
    ["WAL_QUARANTINE_NOTE_FILE", WAL_QUARANTINE_NOTE_FILE],
    ["WAL_CORRUPT_STRIKE_FILE", WAL_CORRUPT_STRIKE_FILE],
  ]) {
    assert.ok(
      PROTECTED.has(val),
      `PROTECTED must contain ${name} ("${val}") — WAL-family names derive ` +
        "from index-wal.js constants so the allowlist can never drift",
    );
  }
});

test("PROTECTED still hard-stops the non-WAL member bytes and sidecars", () => {
  for (const f of [
    "bm25.json",
    "hnsw.bin",
    "hnsw.bin.meta.json",
    "vectors.jsonl",
    "embeddings-sidecar.jsonl",
    "pending-adds.jsonl",
  ]) {
    assert.ok(
      PROTECTED.has(f),
      `PROTECTED must keep protecting member/sidecar/journal "${f}"`,
    );
  }
});
