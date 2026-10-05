// ledger-checkpoint.test.mjs — S1 regression gate for the newline-safe
// pinned-EOF checkpoint primitive (mcp/lib/synthesis/ledger-checkpoint.js).
//
// WHAT THIS GUARDS (each assertion can FAIL against a plausibly-wrong
// implementation — a raw stat.size cursor, size+mtime-only verification,
// or a full-file hash):
//   (a) append          — delta reads yield exactly the appended rows.
//   (b) torn line       — eof excludes the torn tail; the completed row is
//                         replayed EXACTLY ONCE (fails for a raw-size cursor).
//   (c) in-place rewrite— block-0 flip at constant size, and final-block
//                         rewrite PLUS growth (the ledger-offset-index.js:350
//                         size>/mtime>= case) both yield prefix-drift.
//   (d) rotation        — shorter -> shrunk; longer+different -> prefix-drift;
//                         missing -> missing.
//   (e) empty file      — eof 0 / witness []; emptyCheckpoint() replays all.
//   (f) one-block file  — final "\n" exactly at byte BLOCK_BYTES.
//   (g) serialize       — JSON round-trip verifies identically; strict nulls.
//   (h) incremental     — prev witness reused as a prefix; bounded-cost gate
//                         (fails for a full-file-hash implementation).
//   (i) fail-closed     — missing/truncated/torn-boundary deltas are non-null
//                         errors, never silent empty coverage (S1b).
//   (j) skip accounting — blank/oversized skips counted; accounting identity;
//                         bytes_scanned hard-clipped at to.eof (S1b).
//   (k) hostile verify  — vacuous/hostile witnesses rejected by validation;
//                         verifyPrefix read cost stays bounded (S1b).
//   (l) capture fallback— drifted-prev and witness-overflow branches produce
//                         valid, verifying checkpoints (S1b).
//   (m) capture signal  — S1c prefix-certified-by-prev flags: verbatim
//                         extension carries non-enumerable extendedPrev;
//                         witness-overflow resample with a VERIFIED prev
//                         carries non-enumerable prefixVerified; unverified
//                         fresh samples (no prev / drifted prev) carry
//                         NEITHER; serialized/persisted shapes stay
//                         byte-identical (flags never survive round-trip).
//
// HERMETICITY: all fixtures under mkdtempSync; the production ledger is
// NEVER read — its stat is snapshotted before and asserted unchanged after.
//
// Run: cd mcp && node test/synthesis/ledger-checkpoint.test.mjs

import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  closeSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

// The checkout this suite runs from. Its default (un-overridden) ledgers,
// policy and indices are what the byte-identity guards below watch; the
// suite itself works under a temp MEMORY_ROOT.
const CHECKOUT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
// ---------------------------------------------------------------------------
// Production-path snapshot BEFORE any work (hermeticity invariant).
// ---------------------------------------------------------------------------
const PROD_MEMORY_JSONL = join(CHECKOUT_ROOT, "ledgers", "memory.jsonl");
function snap(p) {
  try {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "missing";
  }
}
const PROD_BEFORE = snap(PROD_MEMORY_JSONL);

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-ledger-checkpoint-"));
process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const {
  captureCheckpoint,
  verifyPrefix,
  readAppended,
  serializeCheckpoint,
  deserializeCheckpoint,
  emptyCheckpoint,
  CHECKPOINT_VERSION,
  BLOCK_BYTES,
} = await import("../../lib/synthesis/ledger-checkpoint.js");

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------
let fixtureN = 0;
function fixturePath() {
  fixtureN += 1;
  return join(TMP_ROOT, `ledger-${fixtureN}.jsonl`);
}

function rowLine(id, pad = "") {
  return JSON.stringify({ id, kind: "fact", ts: "2026-07-12T00:00:00Z", pad }) + "\n";
}

/** Collect delta rows as { ids, texts, res }. */
function collect(path, from, to) {
  const ids = [];
  const texts = [];
  const res = readAppended(path, from, to, (text) => {
    texts.push(text);
    ids.push(JSON.parse(text).id);
  });
  return { ids, texts, res };
}

/** XOR-flip one byte in place at `off` (fixture files only). */
function flipByteAt(path, off) {
  const fd = openSync(path, "r+");
  try {
    const b = Buffer.alloc(1);
    assert.equal(readSync(fd, b, 0, 1, off), 1);
    b[0] ^= 0x01;
    writeSync(fd, b, 0, 1, off);
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// (a) append
// ---------------------------------------------------------------------------
test("a: append — delta yields exactly the appended rows, in order", () => {
  const path = fixturePath();
  writeFileSync(path, rowLine("n1") + rowLine("n2") + rowLine("n3"));
  const cp1 = captureCheckpoint(path);
  assert.ok(cp1);
  assert.equal(cp1.v, CHECKPOINT_VERSION);
  assert.equal(cp1.algo, "sha256");
  assert.equal(cp1.eof, cp1.size); // file ends in \n -> eof === size

  appendFileSync(path, rowLine("m1") + rowLine("m2") + rowLine("m3") + rowLine("m4"));
  assert.equal(verifyPrefix(path, cp1).ok, true);

  const cp2 = captureCheckpoint(path);
  const { ids, res } = collect(path, cp1, cp2);
  assert.deepEqual(ids, ["m1", "m2", "m3", "m4"]);
  assert.equal(res.lines, 4);
  assert.equal(res.error, null);
  assert.equal(res.bytes, cp2.eof - cp1.eof);

  // Zero-width delta yields zero rows.
  const zero = collect(path, cp1, cp1);
  assert.deepEqual(zero.ids, []);
  assert.equal(zero.res.lines, 0);
});

// ---------------------------------------------------------------------------
// (b) torn line then completion — the load-bearing case
// ---------------------------------------------------------------------------
test("b: torn final line excluded, completed row replayed exactly once", () => {
  const path = fixturePath();
  writeFileSync(path, rowLine("base1") + rowLine("base2"));
  const cp1 = captureCheckpoint(path);

  const torn = rowLine("torn1");
  const cut = Math.floor(torn.length / 2); // mid-row, no trailing \n
  appendFileSync(path, rowLine("c1") + rowLine("c2") + torn.slice(0, cut));

  const cpT = captureCheckpoint(path);
  assert.ok(cpT.eof < cpT.size, "eof must exclude the torn tail bytes");
  assert.equal(cpT.size - cpT.eof, cut);

  const first = collect(path, cp1, cpT);
  assert.deepEqual(first.ids, ["c1", "c2"], "torn row must not be delivered");

  // Complete the torn row.
  appendFileSync(path, torn.slice(cut));
  const cp3 = captureCheckpoint(path);
  assert.equal(cp3.eof, cp3.size);

  const second = collect(path, cpT, cp3);
  assert.deepEqual(second.ids, ["torn1"], "completed row delivered exactly once");
  assert.deepEqual(JSON.parse(second.texts[0]), {
    id: "torn1",
    kind: "fact",
    ts: "2026-07-12T00:00:00Z",
    pad: "",
  });

  // No loss, no double-apply: (cp1->cpT) + (cpT->cp3) === (cp1->cp3).
  const whole = collect(path, cp1, cp3);
  assert.deepEqual(first.ids.concat(second.ids), whole.ids);
});

// ---------------------------------------------------------------------------
// (c) in-place rewrite detected
// ---------------------------------------------------------------------------
test("c1: byte flip in block 0 at constant size -> prefix-drift", () => {
  const path = fixturePath();
  writeFileSync(path, rowLine("r1") + rowLine("r2") + rowLine("r3"));
  const cp = captureCheckpoint(path);
  const sizeBefore = statSync(path).size;

  flipByteAt(path, 10); // inside block 0, size unchanged
  assert.equal(statSync(path).size, sizeBefore);

  assert.deepEqual(verifyPrefix(path, cp), { ok: false, reason: "prefix-drift" });
});

test("c2: rewrite in final witness block PLUS growth (ledger-offset-index.js:350 case) -> prefix-drift", () => {
  const path = fixturePath();
  // ~3 blocks so the final witness block is distinct from block 0.
  const pad = "x".repeat(1000);
  let body = "";
  for (let i = 0; i < 200; i++) body += rowLine(`big${i}`, pad);
  writeFileSync(path, body);
  const cp = captureCheckpoint(path);
  assert.ok(cp.eof > 2 * BLOCK_BYTES, "fixture must span multiple blocks");

  // Rewrite a byte inside the final witness block, then GROW the file so
  // size > cp.size and mtime >= cp.mtimeMs — the exact case the size+mtime
  // grow branch wrongly accepts.
  flipByteAt(path, cp.eof - 10);
  appendFileSync(path, rowLine("post1") + rowLine("post2"));
  const st = statSync(path);
  assert.ok(st.size > cp.size);
  assert.ok(st.mtimeMs >= cp.mtimeMs);

  assert.deepEqual(verifyPrefix(path, cp), { ok: false, reason: "prefix-drift" });
});

// ---------------------------------------------------------------------------
// (d) rotation detected
// ---------------------------------------------------------------------------
test("d: rotation — shrunk / prefix-drift / missing", () => {
  // Shorter replacement -> shrunk.
  const p1 = fixturePath();
  writeFileSync(p1, rowLine("a1") + rowLine("a2") + rowLine("a3"));
  const cpShrink = captureCheckpoint(p1);
  writeFileSync(p1, rowLine("z"));
  assert.ok(statSync(p1).size < cpShrink.eof);
  assert.deepEqual(verifyPrefix(p1, cpShrink), { ok: false, reason: "shrunk" });

  // Longer replacement with different leading bytes -> prefix-drift.
  const p2 = fixturePath();
  writeFileSync(p2, rowLine("b1") + rowLine("b2"));
  const cpRot = captureCheckpoint(p2);
  let rotated = "";
  for (let i = 0; i < 20; i++) rotated += rowLine(`rotated${i}`);
  assert.ok(rotated.length > cpRot.size);
  writeFileSync(p2, rotated);
  assert.deepEqual(verifyPrefix(p2, cpRot), { ok: false, reason: "prefix-drift" });

  // Missing file -> missing.
  const p3 = fixturePath();
  writeFileSync(p3, rowLine("gone"));
  const cpGone = captureCheckpoint(p3);
  rmSync(p3);
  assert.deepEqual(verifyPrefix(p3, cpGone), { ok: false, reason: "missing" });
});

// ---------------------------------------------------------------------------
// (e) empty file
// ---------------------------------------------------------------------------
test("e: empty file — eof 0, witness [], emptyCheckpoint replays all", () => {
  const path = fixturePath();
  writeFileSync(path, "");
  const cp0 = captureCheckpoint(path);
  assert.equal(cp0.size, 0);
  assert.equal(cp0.eof, 0);
  assert.deepEqual(cp0.witness, []);
  assert.equal(verifyPrefix(path, cp0).ok, true);

  appendFileSync(path, rowLine("e1") + rowLine("e2") + rowLine("e3"));
  const cpNew = captureCheckpoint(path);

  // The origin cursor verifies against any existing file and replays all.
  const origin = emptyCheckpoint();
  assert.deepEqual(origin, {
    v: 1,
    algo: "sha256",
    size: 0,
    eof: 0,
    mtimeMs: null,
    ino: null,
    witness: [],
  });
  assert.equal(verifyPrefix(path, origin).ok, true);
  const all = collect(path, origin, cpNew);
  assert.deepEqual(all.ids, ["e1", "e2", "e3"]);
});

// ---------------------------------------------------------------------------
// (f) exactly-one-block file
// ---------------------------------------------------------------------------
test("f: final \\n exactly at byte BLOCK_BYTES — boundary-exact capture and delta", () => {
  const path = fixturePath();
  // Build one row whose line (incl. "\n") is exactly BLOCK_BYTES bytes.
  const skeleton = rowLine("blk0", "");
  const padLen = BLOCK_BYTES - skeleton.length;
  assert.ok(padLen > 0);
  const line = rowLine("blk0", "y".repeat(padLen));
  assert.equal(Buffer.byteLength(line), BLOCK_BYTES);
  writeFileSync(path, line);

  const cp1 = captureCheckpoint(path);
  assert.equal(cp1.size, BLOCK_BYTES);
  assert.equal(cp1.eof, BLOCK_BYTES);
  // Witness covers [0, BLOCK_BYTES) exactly.
  assert.equal(Math.min(...cp1.witness.map((e) => e.off)), 0);
  assert.equal(Math.max(...cp1.witness.map((e) => e.off + e.len)), BLOCK_BYTES);
  assert.equal(verifyPrefix(path, cp1).ok, true);

  // The single block-boundary row replays from the origin.
  const full = collect(path, emptyCheckpoint(), cp1);
  assert.deepEqual(full.ids, ["blk0"]);

  // Append one row: delta reads are exact at the block boundary.
  appendFileSync(path, rowLine("after"));
  assert.equal(verifyPrefix(path, cp1).ok, true);
  const cp2 = captureCheckpoint(path);
  const delta = collect(path, cp1, cp2);
  assert.deepEqual(delta.ids, ["after"]);
  assert.equal(delta.res.bytes, cp2.eof - BLOCK_BYTES);
});

// ---------------------------------------------------------------------------
// (g) serialize round-trip
// ---------------------------------------------------------------------------
test("g: serialize/deserialize round-trip and strict rejection", () => {
  const path = fixturePath();
  writeFileSync(path, rowLine("s1") + rowLine("s2"));
  const cp = captureCheckpoint(path);

  const ser = serializeCheckpoint(cp);
  assert.ok(ser);
  assert.notEqual(ser, cp); // deep copy, not the same reference
  assert.notEqual(ser.witness, cp.witness);
  const back = deserializeCheckpoint(JSON.stringify(ser));
  assert.deepEqual(back, cp);
  assert.equal(verifyPrefix(path, back).ok, true);
  // ...and it verifies identically after drift, too.
  flipByteAt(path, 5);
  assert.deepEqual(verifyPrefix(path, back), verifyPrefix(path, cp));

  // Object form is accepted directly.
  assert.deepEqual(deserializeCheckpoint(ser), cp);

  // Strict rejection -> null.
  const goodHash = "a".repeat(64);
  assert.equal(deserializeCheckpoint("not json {"), null);
  assert.equal(deserializeCheckpoint(null), null);
  assert.equal(deserializeCheckpoint(42), null);
  assert.equal(deserializeCheckpoint([]), null);
  assert.equal(deserializeCheckpoint({ ...cp, v: 2 }), null);
  assert.equal(deserializeCheckpoint({ ...cp, algo: "md5" }), null);
  assert.equal(deserializeCheckpoint({ ...cp, size: -1 }), null);
  assert.equal(deserializeCheckpoint({ ...cp, eof: cp.size + 1 }), null);
  assert.equal(deserializeCheckpoint({ ...cp, eof: 1.5 }), null);
  assert.equal(
    deserializeCheckpoint({ ...cp, witness: [{ off: -1, len: 1, hash: goodHash }] }),
    null,
  );
  assert.equal(
    deserializeCheckpoint({ ...cp, witness: [{ off: 0, len: cp.eof + 1, hash: goodHash }] }),
    null,
  );
  assert.equal(
    deserializeCheckpoint({ ...cp, witness: [{ off: 0, len: 0, hash: goodHash }] }),
    null,
  );
  assert.equal(
    deserializeCheckpoint({ ...cp, witness: [{ off: 0, len: 1, hash: "A".repeat(64) }] }),
    null,
  );
  assert.equal(
    deserializeCheckpoint({ ...cp, witness: [{ off: 0, len: 1, hash: "ab" }] }),
    null,
  );
  assert.equal(serializeCheckpoint({ ...cp, v: 2 }), null);
  assert.equal(serializeCheckpoint("garbage"), null);
});

// ---------------------------------------------------------------------------
// (h) incremental capture + bounded-cost gate (~20 MB fixture)
// ---------------------------------------------------------------------------
test("h: incremental capture reuses prev witness; bounded cost", () => {
  const path = fixturePath();
  const pad = "z".repeat(160);
  // ~20 MB initial body, written in batches.
  const targetInitial = 20 * 1024 * 1024;
  let written = 0;
  let i = 0;
  while (written < targetInitial) {
    let batch = "";
    for (let j = 0; j < 2000 && written + batch.length < targetInitial; j++) {
      batch += rowLine(`h${i++}`, pad);
    }
    appendFileSync(path, batch);
    written += batch.length;
  }
  const cp1 = captureCheckpoint(path);
  assert.ok(cp1.eof > 19 * 1024 * 1024);

  // Append ~2 MB more, then capture incrementally.
  let extra = "";
  for (let j = 0; j < 9000; j++) extra += rowLine(`hx${j}`, pad);
  appendFileSync(path, extra);

  const cp2 = captureCheckpoint(path, { prev: cp1 });
  const fresh = captureCheckpoint(path);
  assert.equal(cp2.eof, fresh.eof);
  assert.equal(cp2.size, fresh.size);

  // prev witness reused verbatim as a prefix of the new witness.
  assert.ok(cp2.witness.length > cp1.witness.length);
  assert.deepEqual(cp2.witness.slice(0, cp1.witness.length), cp1.witness);

  // Both verify ok against the grown file.
  assert.equal(verifyPrefix(path, cp2).ok, true);
  assert.equal(verifyPrefix(path, fresh).ok, true);

  // Bounded-cost gate (falsifiable: a full-file hash fails this).
  const fileSize = statSync(path).size;
  for (const cp of [cp2, fresh]) {
    assert.ok(cp.witness.length <= 128, `witness entries ${cp.witness.length} > 128`);
    const sumLen = cp.witness.reduce((s, e) => s + e.len, 0);
    assert.ok(sumLen <= 128 * BLOCK_BYTES);
    assert.ok(sumLen < fileSize / 2, `witness covers ${sumLen} of ${fileSize} bytes`);
  }

  // Both the incremental and the fresh checkpoint detect a block-0 flip.
  flipByteAt(path, 100);
  assert.deepEqual(verifyPrefix(path, cp2), { ok: false, reason: "prefix-drift" });
  assert.deepEqual(verifyPrefix(path, fresh), { ok: false, reason: "prefix-drift" });
  flipByteAt(path, 100); // restore

  // cp2 re-verifies once the flip is restored — the file is byte-identical
  // to when cp2 was captured. (The drifted-prev capture fallback itself —
  // captureCheckpoint actually called with a drifted prev — is covered in
  // test l1; witness-overflow fallback in l2.)
  assert.equal(verifyPrefix(path, cp2).ok, true);
});

// ---------------------------------------------------------------------------
// RED-FIRST RECORD (pre-S1b failures)
//
// Sections (i)/(j)/(k) below were written FIRST and run against the
// UNMODIFIED S1 module (2026-07-12). Verbatim pre-fix failures:
//
//   i1: missing file            -> res.error was `null` (expected "missing");
//       a rm'd file read as clean empty coverage: `null !== 'missing'`.
//   i2: truncation < to.eof     -> res.error was `null` (expected "truncated"):
//       `actual: null, expected: 'truncated'`.
//   i3: "x" at to.eof-1         -> res.error was `null` (expected
//       "torn-boundary"): `actual: null, expected: 'torn-boundary'`.
//   j1: skipped_blank           -> `undefined !== 2` (field did not exist).
//   j2: skipped_oversized       -> `undefined !== 1` (5th opts arg ignored;
//       field did not exist).
//   j3: skipped_oversized       -> `undefined !== 1` (default 8 MiB budget
//       skipped the line but reported nothing).
//   j4: bytes_scanned           -> `bytes_scanned undefined exceeds delta
//       5065` (field did not exist; pre-fix stream scanned to file EOF).
//   k1: empty witness, eof>0    -> verifyPrefix gave `{ ok: true, reason:
//       null }` (vacuous verify; expected invalid-checkpoint).
//   k2: 5000-entry hostile      -> verifyPrefix gave `{ ok: true, reason:
//       null }` after ~312 MiB of reads (1382ms cold; expected
//       invalid-checkpoint).
//   k3: >128 entries            -> verifyPrefix gave `reason: 'prefix-drift'`
//       after READING the file (expected 'invalid-checkpoint' with no I/O);
//       deserializeCheckpoint accepted every density/shape variant.
//   k4 passed pre-fix (emptyCheckpoint semantics were already correct).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// (i) fail-closed file errors — S1b red-first
// ---------------------------------------------------------------------------
test("i1: missing file -> error 'missing' (never mistakable for empty coverage)", () => {
  const path = fixturePath();
  writeFileSync(path, rowLine("i1a") + rowLine("i1b"));
  const from = captureCheckpoint(path);
  appendFileSync(path, rowLine("i1c"));
  const to = captureCheckpoint(path);
  rmSync(path);
  const res = readAppended(path, from, to, () => {});
  assert.equal(res.error, "missing");
  assert.notEqual(res.error, null, "missing file must NOT read as clean empty coverage");
});

test("i2: truncation to a mid-line byte below to.eof -> 'truncated'", () => {
  const path = fixturePath();
  writeFileSync(path, rowLine("t1") + rowLine("t2") + rowLine("t3"));
  const to = captureCheckpoint(path);
  const cutTo = to.eof - Math.floor(rowLine("t3").length / 2); // mid-line, < to.eof
  assert.ok(cutTo < to.eof);
  truncateSync(path, cutTo);
  const res = readAppended(path, emptyCheckpoint(), to, () => {});
  assert.equal(res.error, "truncated");
});

test("i3: non-newline byte at to.eof-1 -> 'torn-boundary'", () => {
  const path = fixturePath();
  writeFileSync(path, rowLine("x1") + rowLine("x2"));
  const to = captureCheckpoint(path);
  // Overwrite the delta's final "\n" with "x" (size unchanged): the current
  // file has NO line boundary at to.eof.
  const fd = openSync(path, "r+");
  try {
    writeSync(fd, Buffer.from("x"), 0, 1, to.eof - 1);
  } finally {
    closeSync(fd);
  }
  const res = readAppended(path, emptyCheckpoint(), to, () => {});
  assert.equal(res.error, "torn-boundary");
});

// ---------------------------------------------------------------------------
// (j) skip accounting + bounded scan — S1b red-first
// ---------------------------------------------------------------------------

/** onLine that never JSON-parses oversized payloads. */
function collectIdsSafe(ids) {
  return (text) => {
    ids.push(text.length < 200 ? JSON.parse(text).id : `RAW(${text.length})`);
  };
}

test("j1: blank-line runs -> skipped_blank; accounting identity holds", () => {
  const path = fixturePath();
  writeFileSync(path, rowLine("jb0"));
  const from = captureCheckpoint(path);
  appendFileSync(path, rowLine("ja") + "\n\n" + rowLine("jc"));
  const to = captureCheckpoint(path);
  const ids = [];
  const res = readAppended(path, from, to, collectIdsSafe(ids));
  assert.deepEqual(ids, ["ja", "jc"]);
  assert.equal(res.error, null);
  assert.equal(res.skipped_blank, 2);
  assert.equal(res.skipped_oversized, 0);
  assert.equal(res.skipped_oversized_bytes, 0);
  // Every delta byte accounted for (each blank line is exactly 1 byte).
  assert.equal(
    res.bytes + res.skipped_oversized_bytes + res.skipped_blank,
    to.eof - from.eof,
  );
});

test("j2: opts.maxLineBytes — oversized line skipped, bytes accounted", () => {
  const path = fixturePath();
  writeFileSync(path, rowLine("jo0"));
  const from = captureCheckpoint(path);
  appendFileSync(path, rowLine("jo1") + "K".repeat(5000) + "\n" + rowLine("jo2"));
  const to = captureCheckpoint(path);
  const ids = [];
  const res = readAppended(path, from, to, collectIdsSafe(ids), { maxLineBytes: 4096 });
  assert.equal(res.skipped_oversized, 1);
  assert.equal(res.skipped_oversized_bytes, 5001); // 5000 content + "\n"
  assert.deepEqual(ids, ["jo1", "jo2"], "normal rows around the oversized line still delivered");
  assert.equal(res.error, null);
  assert.equal(res.lines, 2);
  assert.equal(
    res.bytes + res.skipped_oversized_bytes + res.skipped_blank,
    to.eof - from.eof,
  );
});

test("j3: default budget pins at 8 MiB (parity with _ledger-stream)", () => {
  const path = fixturePath();
  writeFileSync(path, rowLine("jd0"));
  const from = captureCheckpoint(path);
  const bigLen = 8 * 1024 * 1024 + 1;
  appendFileSync(path, "Q".repeat(bigLen) + "\n");
  const to = captureCheckpoint(path);
  const res = readAppended(path, from, to, () => {
    throw new Error("oversized line must not be delivered under the default budget");
  });
  assert.equal(res.skipped_oversized, 1);
  assert.equal(res.skipped_oversized_bytes, bigLen + 1);
  assert.equal(res.error, null);
  assert.equal(res.lines, 0);
  assert.equal(
    res.bytes + res.skipped_oversized_bytes + res.skipped_blank,
    to.eof - from.eof,
  );
});

test("j4: bytes_scanned <= to.eof - from.eof even when the delta ends oversized and rows follow to.eof", () => {
  const path = fixturePath();
  writeFileSync(path, rowLine("js0"));
  const from = captureCheckpoint(path);
  // Delta's FINAL line is oversized (under maxLineBytes 4096), so a
  // stream-based reader has no deliverable line past it to trigger an
  // early stop — the pre-fix code scans to file EOF.
  appendFileSync(path, rowLine("js1") + "K".repeat(5000) + "\n");
  const to = captureCheckpoint(path);
  // Rows appended AFTER to.eof must never be scanned.
  appendFileSync(path, rowLine("after1") + rowLine("after2"));
  const ids = [];
  const res = readAppended(path, from, to, collectIdsSafe(ids), { maxLineBytes: 4096 });
  assert.ok(
    res.bytes_scanned <= to.eof - from.eof,
    `bytes_scanned ${res.bytes_scanned} exceeds delta ${to.eof - from.eof}`,
  );
  assert.deepEqual(ids, ["js1"]);
  assert.equal(res.error, null);
  assert.equal(res.skipped_oversized, 1);
  assert.equal(
    res.bytes + res.skipped_oversized_bytes + res.skipped_blank,
    to.eof - from.eof,
  );
});

// ---------------------------------------------------------------------------
// (k) hostile / vacuous verify — S1b red-first
// ---------------------------------------------------------------------------
test("k1: empty witness with eof > 0 -> invalid-checkpoint (no vacuous verify)", () => {
  const path = fixturePath();
  writeFileSync(path, rowLine("k1a") + rowLine("k1b"));
  const st = statSync(path);
  const vacuous = {
    v: 1,
    algo: "sha256",
    size: st.size,
    eof: st.size, // file ends in "\n" so the true newline-safe eof
    mtimeMs: null,
    ino: null,
    witness: [],
  };
  assert.ok(vacuous.eof > 0);
  assert.deepEqual(verifyPrefix(path, vacuous), { ok: false, reason: "invalid-checkpoint" });
  assert.equal(deserializeCheckpoint(vacuous), null);
});

test("k2: hostile 5000-entry duplicate witness -> invalid-checkpoint (no read amplification)", () => {
  const path = fixturePath();
  const pad = "w".repeat(1000);
  let body = "";
  for (let i = 0; i < 1000; i++) body += rowLine(`k2-${i}`, pad); // ~1 MiB
  writeFileSync(path, body);
  const real = captureCheckpoint(path);
  assert.ok(real.eof > BLOCK_BYTES);
  // Correct sha256 of block 0 — every entry satisfies the pre-fix
  // per-entry checks AND hashes true, so only density validation stops it.
  const fd = openSync(path, "r");
  const b0 = Buffer.alloc(BLOCK_BYTES);
  try {
    assert.equal(readSync(fd, b0, 0, BLOCK_BYTES, 0), BLOCK_BYTES);
  } finally {
    closeSync(fd);
  }
  const h0 = createHash("sha256").update(b0).digest("hex");
  const hostile = {
    v: 1,
    algo: "sha256",
    size: real.size,
    eof: real.eof,
    mtimeMs: null,
    ino: null,
    witness: Array.from({ length: 5000 }, () => ({ off: 0, len: BLOCK_BYTES, hash: h0 })),
  };
  assert.deepEqual(verifyPrefix(path, hostile), { ok: false, reason: "invalid-checkpoint" });
  assert.equal(deserializeCheckpoint(hostile), null);
});

test("k3: density/shape rejections — verifyPrefix AND deserializeCheckpoint agree", () => {
  const path = fixturePath();
  // >= 3-block fixture so block geometry is non-trivial.
  const pad = "s".repeat(1000);
  let body = "";
  while (body.length < 3 * BLOCK_BYTES + 500) body += rowLine("k3", pad);
  writeFileSync(path, body);
  const real = captureCheckpoint(path);
  const eof = real.eof;
  const B = BLOCK_BYTES;
  const lastOff = Math.floor((eof - 1) / B) * B;
  const finalLen = eof - lastOff;
  const H = "a".repeat(64);
  const zeroE = { off: 0, len: B, hash: H };
  const finalE = { off: lastOff, len: finalLen, hash: H };
  const shape = (witness, eofV = eof, sizeV = eofV) => ({
    v: 1,
    algo: "sha256",
    size: sizeV,
    eof: eofV,
    mtimeMs: null,
    ino: null,
    witness,
  });

  const rejects = {
    "witness > 128 entries": shape(
      Array.from({ length: 128 }, () => ({ ...zeroE })).concat([{ ...finalE }]),
    ),
    "no off===0 entry when eof>0": shape([{ off: B, len: B, hash: H }, { ...finalE }]),
    "no off+len===eof entry": shape([{ ...zeroE }]),
    "off % BLOCK_BYTES !== 0": shape([
      { ...zeroE },
      { off: B + 2, len: B, hash: H },
      { ...finalE },
    ]),
    "len > BLOCK_BYTES": shape([{ off: 0, len: B + 1, hash: H }, { ...finalE }]),
    "decreasing offsets": shape([{ ...zeroE }, { ...finalE }, { off: B, len: B, hash: H }]),
    "eof===0 with non-empty witness": shape([{ off: 0, len: 1, hash: H }], 0),
  };
  for (const [label, cp] of Object.entries(rejects)) {
    assert.deepEqual(
      verifyPrefix(path, cp),
      { ok: false, reason: "invalid-checkpoint" },
      `verifyPrefix must reject: ${label}`,
    );
    assert.equal(deserializeCheckpoint(cp), null, `deserializeCheckpoint must reject: ${label}`);
  }
});

test("k4: emptyCheckpoint() semantics preserved — validates and verifies ok", () => {
  const path = fixturePath();
  writeFileSync(path, rowLine("k4"));
  const origin = emptyCheckpoint();
  assert.ok(serializeCheckpoint(origin));
  assert.deepEqual(deserializeCheckpoint(JSON.stringify(origin)), origin);
  assert.deepEqual(verifyPrefix(path, origin), { ok: true, reason: null });
});

// ---------------------------------------------------------------------------
// (l) capture fallback coverage — S1b (coverage, not red-first)
// ---------------------------------------------------------------------------
test("l1: drifted prev is NOT reused — fresh-sample fallback re-hashes current bytes", () => {
  const path = fixturePath();
  writeFileSync(path, rowLine("ld1") + rowLine("ld2") + rowLine("ld3"));
  const cp1 = captureCheckpoint(path);
  assert.ok(cp1);
  assert.equal(cp1.witness[0].off, 0);

  // Drift block 0, then capture WITH the now-stale prev: the incremental
  // gate's verifyPrefix(prev) fails, so the fresh-sample fallback must run.
  flipByteAt(path, 4);
  assert.equal(verifyPrefix(path, cp1).ok, false);

  const cp2 = captureCheckpoint(path, { prev: cp1 });
  assert.ok(cp2, "fallback capture must succeed despite a drifted prev");
  assert.deepEqual(verifyPrefix(path, cp2), { ok: true, reason: null });
  const b0 = cp2.witness.find((e) => e.off === 0);
  assert.ok(b0, "fresh sample must cover block 0");
  assert.notEqual(
    b0.hash,
    cp1.witness[0].hash,
    "drifted prev witness must NOT be reused: block-0 hash must reflect the flipped bytes",
  );
  // Captured fallback output satisfies the tightened validation.
  assert.ok(serializeCheckpoint(cp2));
});

test("l2: witness-overflow fallback — fresh resample instead of a 129th entry", () => {
  const path = fixturePath();
  writeFileSync(path, rowLine("lw-seed"));
  let prev = captureCheckpoint(path);
  assert.ok(prev);

  const pad = "v".repeat(200);
  let sawDuplicateOff = false; // chained-incremental duplicate-off stacking
  let resampleRound = -1;
  let rowN = 0;

  // Each round appends ~2 blocks (~128 KiB) and captures incrementally.
  // Incremental reuse adds ~3 entries/round, so reuse would exceed
  // MAX_WITNESS_ENTRIES (128) around round ~43; cap at 80 for safety.
  for (let round = 0; round < 80; round++) {
    let batch = "";
    while (batch.length < 2 * BLOCK_BYTES) batch += rowLine(`lw${rowN++}`, pad);
    appendFileSync(path, batch);

    const cp = captureCheckpoint(path, { prev });
    assert.ok(cp, `round ${round}: capture returned null`);
    assert.ok(
      cp.witness.length <= 128,
      `round ${round}: witness has ${cp.witness.length} entries (> 128)`,
    );
    // Every intermediate checkpoint — including the duplicate-off stacking
    // the incremental path produces — passes the tightened validation and
    // verifies against the current bytes.
    assert.ok(serializeCheckpoint(cp), `round ${round}: captured output failed validation`);
    assert.deepEqual(
      verifyPrefix(path, cp),
      { ok: true, reason: null },
      `round ${round}: captured checkpoint failed verify`,
    );

    const reusedPrefix =
      cp.witness.length >= prev.witness.length &&
      JSON.stringify(cp.witness.slice(0, prev.witness.length)) ===
        JSON.stringify(prev.witness);
    if (reusedPrefix) {
      // Incremental path: prev's short final-block entry and its full-block
      // re-hash legitimately stack at the SAME off (non-decreasing, not
      // strictly increasing — a strictly-increasing isValidCheckpoint would
      // reject the library's own output here).
      for (let k = 1; k < cp.witness.length; k++) {
        if (cp.witness[k].off === cp.witness[k - 1].off) sawDuplicateOff = true;
      }
    } else {
      // Overflow fallback fired: fresh resample, NOT prefixed by prev.
      resampleRound = round;
      assert.ok(
        cp.witness.length <= 65,
        `fresh resample has ${cp.witness.length} entries (> TARGET_SAMPLES + final block)`,
      );
      break;
    }
    prev = cp;
  }

  assert.ok(resampleRound > 0, "witness-overflow fresh-resample round never occurred");
  assert.ok(
    sawDuplicateOff,
    "chained incremental capture never stacked two entries at the same off",
  );
});

// ---------------------------------------------------------------------------
// (m) capture prefix-certified-by-prev signal — S1c
//
// RED-FIRST RECORD (pre-S1c, 2026-07-14, scratchpad copy): captureCheckpoint
// attached NO signal on any path, so callers could not tell a witness-cap
// overflow with a verified prefix (safe to fold) from a genuine rewrite
// fallback (must full-rebuild) — content-index full-rebuilt with reason
// 'checkpoint-discontinuity' at witness entry 128 (~every ~63-127 gaining
// ticks) and health-reducers rebuilt with reason 'capture-fallback' at the
// same cap. m1/m2 assertions on the flags fail on that code.
// ---------------------------------------------------------------------------
test("m1: verbatim extension carries non-enumerable extendedPrev; fresh sample carries neither", () => {
  const path = fixturePath();
  writeFileSync(path, rowLine("m1-a") + rowLine("m1-b"));
  const fresh = captureCheckpoint(path);
  assert.ok(fresh);
  assert.equal(fresh.extendedPrev, undefined, "fresh sample must not claim extension");
  assert.equal(fresh.prefixVerified, undefined, "fresh sample must not claim verification");

  appendFileSync(path, rowLine("m1-c"));
  const inc = captureCheckpoint(path, { prev: fresh });
  assert.ok(inc);
  assert.equal(inc.extendedPrev, true, "verbatim extension must carry extendedPrev");
  assert.equal(inc.prefixVerified, undefined, "extension path uses extendedPrev, not prefixVerified");
  // Non-enumerable: persisted/serialized shapes stay byte-identical.
  assert.ok(!Object.keys(inc).includes("extendedPrev"));
  assert.ok(!JSON.stringify(inc).includes("extendedPrev"));
  const ser = serializeCheckpoint(inc);
  assert.ok(ser);
  assert.equal(ser.extendedPrev, undefined, "serializeCheckpoint must drop the flag");
  const round = deserializeCheckpoint(JSON.stringify(ser));
  assert.ok(round);
  assert.equal(round.extendedPrev, undefined, "flag must not survive a JSON round-trip");
  assert.equal(round.prefixVerified, undefined);
});

test("m2: witness-overflow resample with verified prev carries non-enumerable prefixVerified", () => {
  const path = fixturePath();
  writeFileSync(path, rowLine("m2-seed"));
  let prev = captureCheckpoint(path);
  assert.ok(prev);

  // Chained small appends stack one same-off entry per capture: the witness
  // hits MAX_WITNESS_ENTRIES (128) within ~128 rounds and the next capture
  // must resample fresh — WITH the prefix verified inside the same call.
  let overflowCp = null;
  for (let i = 0; i < 200; i++) {
    appendFileSync(path, rowLine(`m2-${i}`));
    const cp = captureCheckpoint(path, { prev });
    assert.ok(cp, `round ${i}: capture returned null`);
    if (cp.extendedPrev !== true) {
      assert.equal(
        cp.prefixVerified,
        true,
        "cap-overflow resample of an append-only file must be marked prefix-certified-by-prev",
      );
      overflowCp = cp;
      break;
    }
    assert.equal(cp.prefixVerified, undefined);
    prev = cp;
  }
  assert.ok(overflowCp, "witness-overflow resample never occurred in 200 rounds");
  assert.equal(overflowCp.extendedPrev, undefined);
  // Non-enumerable + never persisted.
  assert.ok(!Object.keys(overflowCp).includes("prefixVerified"));
  assert.ok(!JSON.stringify(overflowCp).includes("prefixVerified"));
  const ser = serializeCheckpoint(overflowCp);
  assert.ok(ser);
  assert.equal(ser.prefixVerified, undefined, "serializeCheckpoint must drop the flag");
  // The resample is a valid, verifying checkpoint (parity with l2).
  assert.deepEqual(verifyPrefix(path, overflowCp), { ok: true, reason: null });
});

test("m3: drifted prev -> unverified fresh fallback carries NEITHER flag", () => {
  const path = fixturePath();
  writeFileSync(path, rowLine("m3-a") + rowLine("m3-b") + rowLine("m3-c"));
  const cp1 = captureCheckpoint(path);
  assert.ok(cp1);
  flipByteAt(path, 4); // block-0 drift: prev's in-capture re-verify fails
  const cp2 = captureCheckpoint(path, { prev: cp1 });
  assert.ok(cp2);
  assert.equal(cp2.extendedPrev, undefined, "drifted prev must not claim extension");
  assert.equal(
    cp2.prefixVerified,
    undefined,
    "drifted prev must NOT be marked prefix-certified — callers fold on this signal",
  );
});

// ---------------------------------------------------------------------------
// Hermeticity: the production ledger was never touched (stat-identical).
// ---------------------------------------------------------------------------
test("hermeticity: production ledger stat unchanged", () => {
  assert.equal(snap(PROD_MEMORY_JSONL), PROD_BEFORE);
});
