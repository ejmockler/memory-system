// ledger-snapshot-pin.test.mjs — A3 regression gate for the reproducible
// ledger-population pin (mcp/scripts/pin-ledger-snapshot.mjs).
//
// WHAT THIS GUARDS. Every assertion below can FAIL against a plausibly-wrong
// implementation — specifically against the shapes an engineer reaches for
// first: a `stat.size` cursor, a digest folded out of the row-reader
// callbacks, a sampled witness mistaken for a cryptographic one, a plain-
// object histogram, and `file://${process.argv[1]}`.
//
//   (a) torn tail      — eof is strictly less than size on a mid-append file,
//                        lands exactly one byte past the last "\n", and
//                        `sha256_prefix` equals a digest the TEST computes
//                        independently over the first `eof` bytes. This is
//                        the falsifiable core.
//   (a2) empty prefix  — a file with no "\n" at all is REFUSED (eof 0 is not
//                        a denominator); --allow-empty forces it and stamps
//                        the relaxation.
//   (b) append-invariance — after appending more rows, the pinned prefix
//                        still verifies and a recompute over the ORIGINAL
//                        pinned eof reproduces the digest and every count
//                        byte-for-byte. A stat.size implementation fails
//                        here, and the arm proves it by showing the
//                        size-keyed digest is a DIFFERENT string.
//   (c) in-place rewrite — a one-byte flip inside [0, eof) between the scan
//                        and the post-scan verification aborts the run with
//                        NO file written; the CLI maps an abort to a
//                        non-zero exit and writes nothing.
//   (d) accounting     — line_count === lines + skipped_blank +
//                        skipped_oversized, and equals `wc -l` over [0, eof)
//                        on a fixture that deliberately contains a blank line
//                        and an oversized line.
//   (e) idempotence    — a re-pin of an unchanged eof reproduces the same
//                        filename with byte-identical content, and no
//                        `.tmp-*` residue survives.
//   (f) row accounting — kind_counts + unparseable_count covers every counted
//                        row; a row with no `kind` lands in an explicit
//                        "<missing>" bucket rather than being dropped.
//   (g) FALSIFIED PREMISE — the emitted field is `kind_counts`, NOT
//                        `type_counts`. Ledger rows have no `type` field
//                        (verified: undefined on 283/283 rows of the live
//                        ledger's trailing 20 MB and on 55,985/55,985
//                        mid-file rows), so a `type_counts` histogram would
//                        be all-undefined — a number no consumer could ever
//                        falsify. This test pins the corrected name.
//
// WAVE-2 ARMS — one per refuted claim. Each was RED against the wave-1
// implementation; the RED/GREEN pair is recorded in nodes/A3.md.
//
//   (h)  an UNSAMPLED interior block of a >4 MiB prefix is mutated after the
//        scan. The sampled witness cannot see it; the default mode re-hashes
//        the whole prefix and aborts. This is the arm that refutes "the
//        post-scan verifyPrefix closes the TOCTOU window".
//   (h2) the SAME mutation under --fast-verify is NOT caught — and the
//        payload says so (verification.method "sampled-witness"). The bound
//        is pinned honestly instead of being hidden.
//   (i)  the CLI is run from a real directory whose name contains a SPACE.
//        `file://${process.argv[1]}` goes false there and main() never runs.
//   (j)  rows whose `kind` is "__proto__" / "constructor" / "toString"
//        survive INTO THE EMITTED BYTES and reconcile there.
//   (j2) the reconciliation guard runs on the SERIALIZED text: a bucket lost
//        at serialization time aborts the run. Without the seam this guard
//        would be untestable, and an untested guard is not a guard.
//   (k)  a hostile writer cannot make the histogram unbounded: past
//        MAX_KIND_BUCKETS kinds fold into "<other>", and a kind longer than
//        MAX_KIND_BYTES folds into "<oversized-kind>". Nothing is dropped.
//   (l)  a 0-row ledger is refused and cannot clobber a good latest.json.
//   (m)  latest.json may not rewind to a SMALLER eof (append-only).
//   (n)  the content-addressed file is WRITE-ONCE under a moving torn tail:
//        byte-identical across re-pins, with only latest.json's observation
//        block moving.
//   (o)  a contradictory pin already at the address aborts the run.
//   (p)  every run states its verification bound in the emitted payload.
//
// HERMETICITY: every fixture lives under mkdtempSync. The production ledger,
// its offset sidecar and indices/ are NEVER read or written — their stats are
// snapshotted before any work and asserted unchanged at the end. The live
// arm is env-opt-in (MEMSYS_PIN_LIVE_LEDGER=1) and DEFAULT-SKIPPED, so a
// default `npm test` never pulls the 2.9 GB ledger through this suite.
//
// Run: cd mcp && node --test test/ledger-snapshot-pin.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADDRESS_FIELDS,
  MAX_KIND_BUCKETS,
  MAX_KIND_BYTES,
  pinLedgerSnapshot,
} from "../scripts/pin-ledger-snapshot.mjs";
import {
  BLOCK_BYTES,
  deserializeCheckpoint,
  emptyCheckpoint,
  readAppended,
  verifyPrefix,
} from "../lib/synthesis/ledger-checkpoint.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "scripts", "pin-ledger-snapshot.mjs");
const LIB_DIR = join(HERE, "..", "lib");

// ---------------------------------------------------------------------------
// Production-path snapshot BEFORE any work (hermeticity invariant, mirrors
// test/synthesis/ledger-checkpoint.test.mjs).
// ---------------------------------------------------------------------------
const PROD_LEDGERS = join(homedir(), "memory-system", "ledgers");
const PROD_PATHS = [
  join(PROD_LEDGERS, "memory.jsonl"),
  join(PROD_LEDGERS, "memory.jsonl.offsets"),
  join(homedir(), "memory-system", "indices"),
];
function snap(p) {
  try {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}:${s.ino}`;
  } catch {
    return "missing";
  }
}
const PROD_BEFORE = PROD_PATHS.map(snap);

// realpathSync: on macOS os.tmpdir() is "/var/..." which is a symlink to
// "/private/var/...". Node realpaths the ESM main entry, so import.meta.url
// is always the REAL path — arm (i) needs argv[1] to be the real path too,
// or it would be testing symlink resolution instead of percent-encoding.
const TMP_ROOT = realpathSync(mkdtempSync(join(tmpdir(), "memsys-ledger-snapshot-pin-")));
process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function fixture(tag) {
  const dir = mkdtempSync(join(TMP_ROOT, `${tag}-`));
  return { dir, ledger: join(dir, "memory.jsonl"), out: join(dir, "snapshots") };
}

function row(id, kind) {
  return `${JSON.stringify({ id, kind, content: `row ${id}` })}\n`;
}

// --- independent oracles (deliberately NOT the production primitives) ------
function sha256Of(path, len) {
  const buf = readFileSync(path);
  return createHash("sha256").update(buf.subarray(0, len)).digest("hex");
}
function newlineCount(path, len) {
  const buf = readFileSync(path).subarray(0, len);
  let n = 0;
  for (let i = 0; i < buf.length; i += 1) if (buf[i] === 0x0a) n += 1;
  return n; // exactly `wc -l` over [0, len)
}
function lastNewlinePlusOne(path) {
  const buf = readFileSync(path);
  return buf.lastIndexOf(0x0a) + 1; // 0 when the file has no "\n"
}
function byteAt(path, off) {
  return readFileSync(path)[off];
}
function setByteAt(path, off, value) {
  const fd = openSync(path, "r+");
  try {
    writeSync(fd, Buffer.from([value]), 0, 1, off);
  } finally {
    closeSync(fd);
  }
}
function flipByteAt(path, off) {
  // read-modify-write a single byte, preserving file length
  const cur = byteAt(path, off);
  setByteAt(path, off, cur === 0x58 ? 0x59 : 0x58); // 'X' <-> 'Y'
}
function listOut(dir) {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}
function tmpResidue(dir) {
  return listOut(dir).filter((f) => f.includes(".tmp-"));
}
function sumCounts(kindCounts) {
  let n = 0;
  for (const k of Object.keys(kindCounts)) n += kindCounts[k];
  return n;
}

// ---------------------------------------------------------------------------
// A >4 MiB fixture, so the witness stride exceeds 1 and INTERIOR BLOCKS GO
// UNSAMPLED. 80 blocks of 64 KiB, built from a row padded to exactly 128 B.
// ---------------------------------------------------------------------------
const BIG_BLOCKS = 80; // > TARGET_SAMPLES (64) => stride 2
const BIG_ROW = (() => {
  const bare = JSON.stringify({ id: "m", kind: "fact", pad: "" });
  const r = `${JSON.stringify({ id: "m", kind: "fact", pad: "a".repeat(127 - bare.length) })}\n`;
  assert.equal(r.length, 128, "the big-fixture row must be exactly 128 bytes");
  return r;
})();
const BIG_BODY = BIG_ROW.repeat((BIG_BLOCKS * BLOCK_BYTES) / BIG_ROW.length);

/** Re-implementation of ledger-checkpoint's (unexported) sampleBlockIndices. */
function sampledBlocks(nBlocks) {
  const stride = Math.max(1, Math.ceil(nBlocks / 64));
  const idxs = new Set();
  for (let i = 0; i < nBlocks; i += stride) idxs.add(i);
  idxs.add(nBlocks - 1);
  return { stride, idxs };
}

/** Writes the big fixture and returns the first block index NOT sampled. */
function writeBigFixture(ledger) {
  writeFileSync(ledger, BIG_BODY);
  const size = statSync(ledger).size;
  assert.equal(size, BIG_BLOCKS * BLOCK_BYTES);
  assert.ok(size > 4 * 1024 * 1024, "the fixture must exceed 64 blocks (4 MiB)");
  const { stride, idxs } = sampledBlocks(BIG_BLOCKS);
  assert.ok(stride > 1, "stride must exceed 1 or nothing is unsampled");
  let unsampled = -1;
  for (let i = 1; i < BIG_BLOCKS - 1; i += 1) {
    if (!idxs.has(i)) {
      unsampled = i;
      break;
    }
  }
  assert.ok(unsampled > 0, "there must be an interior block the witness never reads");
  return { size, unsampled, offset: unsampled * BLOCK_BYTES + 17, sampledCount: idxs.size };
}

// ===========================================================================
// (a) TORN TAIL — the falsifiable core.
// ===========================================================================
test("a: torn tail — eof < size, sits one byte past the last newline, and the digest covers exactly [0, eof)", async () => {
  const { ledger, out } = fixture("a-torn");
  const complete = row("a1", "fact") + row("a2", "reconstructed") + row("a3", "fact");
  const torn = '{"id":"a4","kind":"fac'; // writer caught mid-append: no "\n"
  writeFileSync(ledger, complete + torn);

  const size = statSync(ledger).size;
  const res = await pinLedgerSnapshot({ ledgerPath: ledger, outDir: out });
  assert.equal(res.ok, true, `pin aborted: ${res.reason} ${res.detail}`);
  const p = res.payload;

  // size / torn_tail_bytes are OBSERVATIONS (they move under a live writer),
  // so they live in latest.json's observation block, never at the address.
  assert.equal(p.observation.size, size);
  assert.ok(p.eof < p.observation.size, "eof must EXCLUDE the torn tail (a stat.size cursor fails here)");
  assert.equal(p.eof, complete.length);
  assert.equal(p.eof, lastNewlinePlusOne(ledger), "eof is the byte just past the last \\n");
  assert.equal(p.observation.torn_tail_bytes, torn.length);

  // The independently computed digest over the first `eof` bytes. If the
  // implementation hashed [0, size) — or folded bytes out of the row
  // callbacks — this equality breaks.
  assert.equal(p.sha256_prefix, sha256Of(ledger, p.eof));
  assert.notEqual(
    p.sha256_prefix,
    sha256Of(ledger, p.observation.size),
    "digest over [0,size) must DIFFER from the pin — otherwise the arm proves nothing",
  );

  assert.equal(p.line_count, 3);
  assert.equal(p.line_count, newlineCount(ledger, p.eof));
  assert.equal(p.id_row_count, 3);
  assert.deepEqual(p.kind_counts, { fact: 2, reconstructed: 1 });
  assert.equal(p.unparseable_count, 0);
  assert.equal(p.kind_bucket_overflow, false);

  // File naming + latest.json.
  const files = listOut(out);
  assert.deepEqual(files, [`${p.eof}-${p.sha256_prefix.slice(0, 12)}.json`, "latest.json"].sort());

  // The addressed file carries the address-determined fields and NOTHING
  // volatile; latest.json is the superset.
  const addressed = JSON.parse(readFileSync(res.snapshotPath, "utf8"));
  assert.deepEqual(Object.keys(addressed).sort(), [...ADDRESS_FIELDS].sort());
  for (const field of ["observation", "verification", "relaxed", "captured_at", "size", "ledger_path"]) {
    assert.equal(field in addressed, false, `${field} must not live at the content address`);
  }
  for (const field of ADDRESS_FIELDS) {
    assert.deepEqual(JSON.parse(readFileSync(res.latestPath, "utf8"))[field], addressed[field]);
  }
});

test("a2: a file with NO trailing newline at all is REFUSED (eof 0), and --allow-empty stamps the relaxation", async () => {
  const { ledger, out } = fixture("a2-nonl");
  writeFileSync(ledger, '{"id":"only","kind":"fact"');

  const refused = await pinLedgerSnapshot({ ledgerPath: ledger, outDir: out });
  assert.equal(refused.ok, false, "eof 0 is not a denominator — it must fail closed");
  assert.equal(refused.reason, "empty-prefix");
  assert.deepEqual(listOut(out), [], "a refused pin writes nothing at all");

  const forced = await pinLedgerSnapshot({ ledgerPath: ledger, outDir: out, allowEmpty: true });
  assert.equal(forced.ok, true);
  assert.equal(forced.payload.eof, 0);
  assert.equal(forced.payload.observation.torn_tail_bytes, statSync(ledger).size);
  assert.equal(forced.payload.line_count, 0);
  assert.equal(forced.payload.id_row_count, 0);
  assert.deepEqual(forced.payload.kind_counts, {});
  assert.deepEqual(forced.payload.relaxed, ["allow-empty"], "an opt-out must say what it relaxed");
  // sha256 of the empty byte range, computed independently.
  assert.equal(forced.payload.sha256_prefix, createHash("sha256").digest("hex"));
});

// ===========================================================================
// (b) APPEND-INVARIANCE — the append-only guarantee, made checkable.
// ===========================================================================
test("b: append after capture moves neither the digest nor any count", async () => {
  const { ledger, out } = fixture("b-append");
  writeFileSync(ledger, row("b1", "fact") + row("b2", "policy") + '{"id":"b3","ki');

  const res = await pinLedgerSnapshot({ ledgerPath: ledger, outDir: out });
  assert.equal(res.ok, true, `pin aborted: ${res.reason} ${res.detail}`);
  const pinned = res.payload;
  const sizeAtCapture = pinned.observation.size;

  // The writer completes the torn row and appends three more.
  appendFileSync(
    ledger,
    `nd":"fact","content":"row b3"}\n${row("b4", "fact")}${row("b5", "reconstructed")}${row("b6", "fact")}`,
  );
  assert.ok(statSync(ledger).size > sizeAtCapture, "fixture must actually have grown");

  // 1. The pinned prefix still verifies against the grown file.
  const cp = deserializeCheckpoint(pinned.observation.checkpoint);
  assert.ok(cp, "the embedded checkpoint must round-trip");
  assert.equal(cp.eof, pinned.eof);
  assert.deepEqual(verifyPrefix(ledger, cp), { ok: true, reason: null });

  // 2. Recomputing over the ORIGINAL pinned eof reproduces the digest exactly.
  assert.equal(sha256Of(ledger, pinned.eof), pinned.sha256_prefix);

  // 3. ...and every count, via the same production primitive.
  let ids = 0;
  const kinds = {};
  const stats = readAppended(ledger, emptyCheckpoint(), cp, (text) => {
    const o = JSON.parse(text);
    if (typeof o.id === "string") ids += 1;
    kinds[o.kind] = (kinds[o.kind] || 0) + 1;
  });
  assert.equal(stats.error, null);
  assert.equal(stats.lines + stats.skipped_blank + stats.skipped_oversized, pinned.line_count);
  assert.equal(ids, pinned.id_row_count);
  assert.deepEqual(kinds, pinned.kind_counts);
  assert.equal(newlineCount(ledger, pinned.eof), pinned.line_count);

  // 4. A stat.size implementation FAILS this arm. Keying on the size current
  //    at capture time hashes the TORN FRAGMENT too, producing a different
  //    digest over a boundary that is not a row boundary — and a reader
  //    resuming from that offset would skip the completed b3 row forever
  //    (the exact defect ledger-checkpoint.js:8-15 was built to close).
  assert.notEqual(
    sha256Of(ledger, sizeAtCapture),
    pinned.sha256_prefix,
    "a size-keyed pin covers the torn fragment — this is what eof-keying buys",
  );
  assert.equal(
    newlineCount(ledger, sizeAtCapture),
    pinned.line_count,
    "the size cursor spans the same rows but a non-row boundary — digest, not count, is the tell",
  );
});

// ===========================================================================
// (c) IN-PLACE REWRITE — fail closed, write nothing.
// ===========================================================================
test("c: a one-byte mutation inside [0, eof) aborts the run and writes NO snapshot", async () => {
  const { ledger, out } = fixture("c-drift");
  writeFileSync(ledger, row("c1", "fact") + row("c2", "fact") + row("c3", "fact"));

  let fired = 0;
  const res = await pinLedgerSnapshot({
    ledgerPath: ledger,
    outDir: out,
    // Verification seam: mutate a byte inside [0, eof) AFTER both read passes
    // and BEFORE the post-scan verification. Byte 3 is inside block 0, which
    // the sampled witness always covers, so even the cheap pre-check sees it.
    // Arm (h) is the one that goes where the witness cannot look.
    hooks: {
      afterScan: () => {
        fired += 1;
        flipByteAt(ledger, 3);
      },
    },
  });

  assert.equal(fired, 1, "the seam must fire exactly once, after the scan");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "prefix-drift");
  assert.deepEqual(listOut(out), [], "a drifted run must leave the output dir empty");
});

test("c2: an abort maps to a non-zero CLI exit and writes nothing", () => {
  const { dir, out } = fixture("c2-cli");
  const missing = join(dir, "does-not-exist.jsonl");
  const r = spawnSync(process.execPath, [SCRIPT, `--ledger=${missing}`, `--out=${out}`], {
    encoding: "utf8",
  });
  assert.notEqual(r.status, 0, "fail-closed must be a non-zero exit");
  assert.match(r.stderr, /ABORTED \(capture-failed/);
  assert.deepEqual(listOut(out), []);
});

test("c3: an existing pin is NOT replaced by an aborted re-run", async () => {
  const { ledger, out } = fixture("c3-keep");
  writeFileSync(ledger, row("k1", "fact") + row("k2", "fact"));
  const good = await pinLedgerSnapshot({ ledgerPath: ledger, outDir: out });
  assert.equal(good.ok, true);
  const before = listOut(out).map((f) => [f, readFileSync(join(out, f), "utf8")]);

  const bad = await pinLedgerSnapshot({
    ledgerPath: ledger,
    outDir: out,
    hooks: { afterScan: () => flipByteAt(ledger, 3) },
  });
  assert.equal(bad.ok, false);
  const after = listOut(out).map((f) => [f, readFileSync(join(out, f), "utf8")]);
  assert.deepEqual(after, before, "the previous good pin must survive an aborted run");
});

// ===========================================================================
// (d) ACCOUNTING — line_count reconciles, and equals `wc -l`.
// ===========================================================================
test("d: line_count === lines + skipped_blank + skipped_oversized === wc -l over [0, eof)", async () => {
  const { ledger, out } = fixture("d-count");
  const MAX = 64; // small cap so the oversized fixture stays cheap
  const big = JSON.stringify({ id: "d-big", kind: "fact", pad: "z".repeat(120) });
  assert.ok(big.length > MAX, "the oversized fixture must actually exceed the cap");
  const body =
    row("d1", "fact") + // delivered
    "\n" + // blank line: 1 byte, counted but never delivered
    `${big}\n` + // oversized: counted, never delivered
    row("d2", "reconstructed"); // delivered
  writeFileSync(ledger, `${body}{"id":"d3","ki`); // + torn tail

  const res = await pinLedgerSnapshot({
    ledgerPath: ledger,
    outDir: out,
    maxLineBytes: MAX,
  });
  assert.equal(res.ok, true, `pin aborted: ${res.reason} ${res.detail}`);
  const p = res.payload;

  assert.equal(p.eof, body.length);
  assert.equal(p.lines, 2, "only the two in-cap non-blank rows are delivered");
  assert.equal(p.skipped_blank, 1);
  assert.equal(p.skipped_oversized, 1);
  assert.equal(p.skipped_oversized_bytes, big.length + 1);
  assert.equal(p.line_count, p.lines + p.skipped_blank + p.skipped_oversized);
  assert.equal(p.line_count, 4);
  assert.equal(
    p.line_count,
    newlineCount(ledger, p.eof),
    "line_count must be the wc -l-comparable figure, not the delivered count",
  );
  // The module's own accounting identity is reconcilable FROM THE PAYLOAD,
  // without re-reading the ledger: every byte of [0, eof) is accounted for.
  assert.equal(p.bytes + p.skipped_oversized_bytes + p.skipped_blank, p.eof);
  assert.equal(p.max_line_bytes, MAX);
  // The oversized row is NOT in kind_counts (it was never delivered/parsed).
  assert.deepEqual(p.kind_counts, { fact: 1, reconstructed: 1 });
  assert.equal(p.id_row_count, 2);
});

// ===========================================================================
// (f) ROW ACCOUNTING + (g) the type -> kind correction.
// ===========================================================================
test("f: kind_counts + unparseable_count account for EVERY counted row; a kind-less row gets an explicit bucket", async () => {
  const { ledger, out } = fixture("f-buckets");
  writeFileSync(
    ledger,
    `${JSON.stringify({ id: "f1" })}\n` + // no kind -> "<missing>"
      "this is not json\n" + // -> unparseable_count
      `${JSON.stringify({ id: "f2", kind: "fact" })}\n` +
      `${JSON.stringify({ kind: "policy" })}\n` + // no id
      `${JSON.stringify({ id: "f3", kind: 7 })}\n`, // non-string kind
  );

  const res = await pinLedgerSnapshot({ ledgerPath: ledger, outDir: out });
  assert.equal(res.ok, true, `pin aborted: ${res.reason} ${res.detail}`);
  const p = res.payload;

  assert.equal(p.line_count, 5);
  assert.equal(p.id_row_count, 3);
  assert.equal(p.unparseable_count, 1);
  assert.deepEqual(p.kind_counts, {
    "<missing>": 1,
    "<non-string>": 1,
    fact: 1,
    policy: 1,
  });
  assert.equal(
    sumCounts(p.kind_counts) + p.unparseable_count,
    p.lines,
    "no delivered row may be silently dropped",
  );
});

test("g: the pin carries kind_counts and NOT type_counts (ledger rows have no `type` field)", async () => {
  const { ledger, out } = fixture("g-field");
  writeFileSync(ledger, row("g1", "fact") + row("g2", "policy"));
  const res = await pinLedgerSnapshot({ ledgerPath: ledger, outDir: out });
  assert.equal(res.ok, true);

  const onDisk = JSON.parse(readFileSync(res.snapshotPath, "utf8"));
  for (const field of ["eof", "sha256_prefix", "line_count", "id_row_count", "kind_counts"]) {
    assert.ok(field in onDisk, `the pin must carry ${field}`);
  }
  assert.equal(
    "type_counts" in onDisk,
    false,
    "type_counts is the A3 spec's falsified premise — rows have `kind`, never `type`",
  );
  assert.deepEqual(onDisk.kind_counts, { fact: 1, policy: 1 });
});

// ===========================================================================
// (e) ATOMICITY / IDEMPOTENCE.
// ===========================================================================
test("e: re-pinning an unchanged eof yields the same filename, byte-identical content, no .tmp-* residue", async () => {
  const { ledger, out } = fixture("e-idem");
  writeFileSync(ledger, row("e1", "fact") + row("e2", "reconstructed") + '{"id":"e3","k');

  const first = await pinLedgerSnapshot({ ledgerPath: ledger, outDir: out });
  assert.equal(first.ok, true);
  const name1 = first.snapshotPath;
  const bytes1 = readFileSync(name1);
  assert.equal(first.rewrote, true);
  assert.deepEqual(tmpResidue(out), []);

  const second = await pinLedgerSnapshot({ ledgerPath: ledger, outDir: out });
  assert.equal(second.ok, true);
  assert.equal(second.snapshotPath, name1, "same eof + digest => same filename");
  assert.equal(second.rewrote, false, "an unchanged prefix is a no-op re-pin");
  assert.deepEqual(readFileSync(second.snapshotPath), bytes1, "content must be byte-identical");
  assert.deepEqual(tmpResidue(out), [], "no .tmp-* residue may survive");
  assert.deepEqual(listOut(out), [`${first.payload.eof}-${first.payload.sha256_prefix.slice(0, 12)}.json`, "latest.json"].sort());

  // latest.json carries the SAME address-determined fields as the addressed
  // pin (it is a superset, deliberately NOT byte-identical: it also carries
  // the fresh observation).
  const latest = JSON.parse(readFileSync(second.latestPath, "utf8"));
  const addressed = JSON.parse(readFileSync(second.snapshotPath, "utf8"));
  for (const f of ADDRESS_FIELDS) assert.deepEqual(latest[f], addressed[f]);
  assert.ok(latest.observation && typeof latest.observation.captured_at === "string");

  // A genuine append produces a NEW content-addressed pin and re-points
  // latest.json, without disturbing the old one.
  appendFileSync(ledger, `ind":"fact","content":"row e3"}\n${row("e4", "fact")}`);
  const third = await pinLedgerSnapshot({ ledgerPath: ledger, outDir: out });
  assert.equal(third.ok, true);
  assert.notEqual(third.snapshotPath, name1);
  assert.deepEqual(readFileSync(name1), bytes1, "the earlier pin is immutable");
  assert.deepEqual(tmpResidue(out), []);
  assert.equal(third.payload.line_count, 4);
  const latest3 = JSON.parse(readFileSync(third.latestPath, "utf8"));
  assert.equal(latest3.eof, third.payload.eof);
});

// ===========================================================================
// (h) THE UNSAMPLED INTERIOR BLOCK — this is the arm that refutes "the
//     post-scan verifyPrefix closes the TOCTOU window".
// ===========================================================================
test("h: a one-byte mutation in an UNSAMPLED interior block of a >4 MiB prefix aborts with prefix-drift and writes nothing", async () => {
  const { ledger, out } = fixture("h-unsampled");
  const { size, unsampled, offset } = writeBigFixture(ledger);
  const original = byteAt(ledger, offset);

  // THE ARM. Mutate an unsampled interior byte through the seam and require
  // the run to abort. A sampled-witness-only implementation returns ok here.
  let fired = 0;
  const res = await pinLedgerSnapshot({
    ledgerPath: ledger,
    outDir: out,
    hooks: {
      afterScan: () => {
        fired += 1;
        flipByteAt(ledger, offset);
      },
    },
  });
  assert.equal(fired, 1);
  assert.equal(res.ok, false, "the default mode must re-hash the whole prefix and catch this");
  assert.equal(res.reason, "prefix-drift");
  assert.match(res.detail, /moved during the scan/);
  assert.equal(statSync(ledger).size, size, "the mutation must preserve file length");
  assert.deepEqual(listOut(out), [], "a drifted run writes nothing");

  // AND THE REFUTATION IT RESTS ON, EXECUTED: the same byte is invisible to
  // the sampled witness, so the wave-1 claim that "the post-scan verifyPrefix
  // closes the TOCTOU window" was false. Restore, pin cleanly, flip again,
  // and watch verifyPrefix say ok over a prefix that has demonstrably moved.
  setByteAt(ledger, offset, original);
  const clean = await pinLedgerSnapshot({ ledgerPath: ledger, outDir: out });
  assert.equal(clean.ok, true, `clean pin aborted: ${clean.reason} ${clean.detail}`);
  const cleanCp = deserializeCheckpoint(clean.payload.observation.checkpoint);
  flipByteAt(ledger, offset);
  assert.deepEqual(
    verifyPrefix(ledger, cleanCp),
    { ok: true, reason: null },
    `block ${unsampled} is outside the sampled witness — verifyPrefix is BLIND here`,
  );
  assert.notEqual(
    sha256Of(ledger, clean.payload.eof),
    clean.payload.sha256_prefix,
    "...while the whole-prefix digest, which the default mode re-runs, does see it",
  );
});

test("h2: --fast-verify does NOT catch the unsampled mutation — and the payload says exactly that", async () => {
  const { ledger, out } = fixture("h2-fast");
  const { offset } = writeBigFixture(ledger);

  const res = await pinLedgerSnapshot({
    ledgerPath: ledger,
    outDir: out,
    fastVerify: true,
    hooks: { afterScan: () => flipByteAt(ledger, offset) },
  });

  // The honest bound: the weaker mode publishes. It does not pretend.
  assert.equal(res.ok, true, "fast mode is sampled-only, so this mutation is invisible to it");
  const v = res.payload.verification ?? {};
  assert.equal(v.method, "sampled-witness", "a weaker mode MUST name itself in the payload");
  assert.ok(v.prefix_bytes_verified < res.payload.eof, "fast mode must NOT claim whole-prefix coverage");
  assert.equal(v.prefix_bytes_verified, v.witness_bytes_verified);
  assert.ok(v.witness_fraction > 0 && v.witness_fraction < 1);
  assert.match(v.residual_note, /NOT detected/);
  assert.deepEqual(res.payload.relaxed, ["fast-verify"]);

  // ...and the proof that it really is weaker: the file on disk no longer
  // matches the digest the pin published.
  assert.notEqual(
    sha256Of(ledger, res.payload.eof),
    res.payload.sha256_prefix,
    "this is the residual --fast-verify buys back — measured, not assumed",
  );
});

// ===========================================================================
// (i) MAIN-MODULE DETECTION — a real path containing a space.
// ===========================================================================
test("i: the CLI runs from a directory whose name contains a SPACE (exit 0, one JSON summary line)", () => {
  const home = join(TMP_ROOT, "pin cli fixture");
  mkdirSync(join(home, "scripts"), { recursive: true });
  // A byte-identical copy of the real script at a REAL path containing a
  // space, with `lib` symlinked so its relative imports resolve to the real
  // modules. `file://${process.argv[1]}` percent-encodes nothing, so the
  // wave-1 guard went false here and main() silently never ran: exit 0, no
  // output, no pin. Note Node realpaths the ESM main entry, which is why the
  // fixture root is realpathSync'd at the top of this file.
  symlinkSync(LIB_DIR, join(home, "lib"), "dir");
  const copied = join(home, "scripts", "pin-ledger-snapshot.mjs");
  copyFileSync(SCRIPT, copied);
  assert.deepEqual(readFileSync(copied), readFileSync(SCRIPT), "the copy must be byte-identical");
  assert.ok(copied.includes(" "), "the fixture path must actually contain a space");

  const ledger = join(home, "memory.jsonl");
  const out = join(home, "snapshots");
  writeFileSync(ledger, row("s1", "fact") + row("s2", "policy"));

  const r = spawnSync(process.execPath, [copied, `--ledger=${ledger}`, `--out=${out}`], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `expected exactly one JSON summary line, got ${lines.length}`);
  const summary = JSON.parse(lines[0]);
  assert.equal(summary.line_count, 2);
  assert.deepEqual(summary.kind_counts, { fact: 1, policy: 1 });
  assert.ok(listOut(out).includes("latest.json"));
});

// ===========================================================================
// (j) HOSTILE KIND KEYS — the histogram must survive SERIALIZATION.
// ===========================================================================
test("j: kinds named __proto__ / constructor / toString survive into the emitted bytes and reconcile there", async () => {
  const { ledger, out } = fixture("j-proto");
  const body =
    row("j1", "__proto__") +
    row("j2", "__proto__") +
    row("j3", "__proto__") +
    row("j4", "constructor") +
    row("j5", "constructor") +
    row("j6", "toString") +
    row("j7", "fact") +
    row("j8", "fact") +
    row("j9", "fact") +
    row("j10", "fact");
  writeFileSync(ledger, body);

  const res = await pinLedgerSnapshot({ ledgerPath: ledger, outDir: out });
  assert.equal(res.ok, true, `pin aborted: ${res.reason} ${res.detail}`);

  // Read the BYTES, not the in-memory object: this is where a plain-object
  // accumulator loses "__proto__" (assignment on Object.prototype's setter is
  // a silent no-op for a non-object value).
  const raw = readFileSync(res.snapshotPath, "utf8");
  assert.match(raw, /"__proto__": 3/, "the emitted JSON must literally carry the __proto__ bucket");
  const onDisk = JSON.parse(raw);
  assert.equal(onDisk.kind_counts["__proto__"], 3);
  assert.equal(onDisk.kind_counts.constructor, 2);
  assert.equal(onDisk.kind_counts.toString, 1);
  assert.equal(onDisk.kind_counts.fact, 4);
  assert.deepEqual(Object.keys(onDisk.kind_counts).sort(), [
    "__proto__",
    "constructor",
    "fact",
    "toString",
  ]);

  // The post-serialization guard's own identity, re-checked from the file.
  assert.equal(onDisk.lines, 10);
  assert.equal(
    sumCounts(onDisk.kind_counts) + onDisk.unparseable_count,
    onDisk.lines,
    "the PUBLISHED histogram must reconcile — an in-memory check cannot see this",
  );
  assert.equal(sumCounts(onDisk.kind_counts), 10);
  // latest.json must reconcile too.
  const latest = JSON.parse(readFileSync(res.latestPath, "utf8"));
  assert.equal(sumCounts(latest.kind_counts) + latest.unparseable_count, latest.lines);
});

test("j2: a bucket lost at SERIALIZATION time aborts the run (serialized-accounting-violated) and writes nothing", async () => {
  const { ledger, out } = fixture("j2-guard");
  writeFileSync(ledger, row("q1", "fact") + row("q2", "policy") + row("q3", "fact"));

  // Fault injection at the exact seam a hostile key exploits: the histogram
  // is correct in memory and wrong in the bytes. An in-memory guard is blind
  // here BY CONSTRUCTION, which is why the guard runs on the serialized text.
  let fired = 0;
  const res = await pinLedgerSnapshot({
    ledgerPath: ledger,
    outDir: out,
    hooks: {
      beforeSerialize: ({ addressPayload }) => {
        fired += 1;
        addressPayload.kind_counts = { fact: 2 }; // policy bucket dropped
      },
    },
  });

  assert.equal(fired, 1, "the seam must fire exactly once, before serialization");
  assert.equal(res.ok, false, "a published histogram that does not reconcile must abort");
  assert.equal(res.reason, "serialized-accounting-violated");
  assert.match(res.detail, /addressed: serialized kind_counts\(2\) \+ unparseable\(0\) != lines\(3\)/);
  assert.deepEqual(listOut(out), [], "nothing may be written when the bytes do not reconcile");
});

// ===========================================================================
// (k) HOSTILE CARDINALITY — bounded buckets, nothing dropped.
// ===========================================================================
test("k: a hostile writer cannot make the histogram unbounded — overflow folds into <other>, long kinds into <oversized-kind>", async () => {
  const { ledger, out } = fixture("k-hostile");
  const N = MAX_KIND_BUCKETS + 64;
  const parts = [
    // First, so it gets its own bucket before the cap bites.
    row("k-long", "L".repeat(MAX_KIND_BYTES + 1)),
  ];
  for (let i = 0; i < N; i += 1) parts.push(row(`k${i}`, `kind-${i}`));
  writeFileSync(ledger, parts.join(""));

  const res = await pinLedgerSnapshot({ ledgerPath: ledger, outDir: out });
  assert.equal(res.ok, true, `pin aborted: ${res.reason} ${res.detail}`);
  const onDisk = JSON.parse(readFileSync(res.snapshotPath, "utf8"));

  assert.equal(onDisk.lines, N + 1);
  assert.equal(onDisk.kind_bucket_overflow, true, "the overflow must be declared, not hidden");
  assert.ok(
    Object.keys(onDisk.kind_counts).length <= MAX_KIND_BUCKETS + 1,
    `bucket cardinality must stay bounded, got ${Object.keys(onDisk.kind_counts).length}`,
  );
  assert.ok(onDisk.kind_counts["<other>"] > 0, "overflowed kinds land in an explicit bucket");
  assert.equal(onDisk.kind_counts["<oversized-kind>"], 1, "a 65-byte kind is folded, not stored");
  assert.equal(
    "L".repeat(MAX_KIND_BYTES + 1) in onDisk.kind_counts,
    false,
    "the oversized kind string must never appear verbatim",
  );
  assert.equal(
    sumCounts(onDisk.kind_counts) + onDisk.unparseable_count,
    onDisk.lines,
    "folding must never DROP a row",
  );
});

// ===========================================================================
// (l) VACUOUS PINS — refused, and unable to clobber a good latest.json.
// ===========================================================================
test("l: an empty ledger is refused and leaves a pre-existing latest.json byte-identical", async () => {
  const { dir, out } = fixture("l-empty");
  const good = join(dir, "good.jsonl");
  const empty = join(dir, "empty.jsonl");
  writeFileSync(good, row("l1", "fact") + row("l2", "fact") + row("l3", "policy"));
  writeFileSync(empty, "");

  const pinned = await pinLedgerSnapshot({ ledgerPath: good, outDir: out });
  assert.equal(pinned.ok, true);
  const before = listOut(out).map((f) => [f, readFileSync(join(out, f), "utf8")]);
  assert.equal(before.length, 2);

  const vacuous = await pinLedgerSnapshot({ ledgerPath: empty, outDir: out });
  assert.equal(vacuous.ok, false, "a 0-row pin is not a pin");
  assert.equal(vacuous.reason, "empty-prefix");
  assert.deepEqual(
    listOut(out).map((f) => [f, readFileSync(join(out, f), "utf8")]),
    before,
    "a good latest.json must survive an empty-ledger re-run byte-identically",
  );

  // ...and the CLI agrees: non-zero exit, empty output dir.
  const freshOut = join(dir, "fresh-snapshots");
  const r = spawnSync(process.execPath, [SCRIPT, `--ledger=${empty}`, `--out=${freshOut}`], {
    encoding: "utf8",
  });
  assert.notEqual(r.status, 0, "a vacuous pin must exit non-zero");
  assert.match(r.stderr, /ABORTED \(empty-prefix/);
  assert.equal(r.stdout, "");
  assert.deepEqual(listOut(freshOut), [], "the abort must not even create the output dir");

  // The explicit opt-out works, and stamps itself.
  const forcedOut = join(dir, "forced-snapshots");
  const forced = spawnSync(
    process.execPath,
    [SCRIPT, `--ledger=${empty}`, `--out=${forcedOut}`, "--allow-empty"],
    { encoding: "utf8" },
  );
  assert.equal(forced.status, 0, forced.stderr);
  assert.deepEqual(JSON.parse(forced.stdout.trim()).relaxed, ["allow-empty"]);
});

// ===========================================================================
// (m) REWIND — an append-only ledger cannot pin backwards by accident.
// ===========================================================================
test("m: latest.json may not rewind to a smaller eof without --allow-rewind", async () => {
  const { dir, out } = fixture("m-rewind");
  const big = join(dir, "big.jsonl");
  const small = join(dir, "small.jsonl");
  writeFileSync(big, row("m1", "fact") + row("m2", "fact") + row("m3", "fact") + row("m4", "fact"));
  writeFileSync(small, row("m1", "fact"));

  const first = await pinLedgerSnapshot({ ledgerPath: big, outDir: out });
  assert.equal(first.ok, true);
  const before = listOut(out).map((f) => [f, readFileSync(join(out, f), "utf8")]);

  const rewind = await pinLedgerSnapshot({ ledgerPath: small, outDir: out });
  assert.equal(rewind.ok, false, "a smaller eof on an append-only ledger is a red flag");
  assert.equal(rewind.reason, "latest-rewind");
  assert.deepEqual(
    listOut(out).map((f) => [f, readFileSync(join(out, f), "utf8")]),
    before,
    "the refused rewind must write nothing at all",
  );

  const forced = await pinLedgerSnapshot({ ledgerPath: small, outDir: out, allowRewind: true });
  assert.equal(forced.ok, true);
  assert.deepEqual(forced.payload.relaxed, ["allow-rewind"]);
  assert.ok(forced.payload.eof < first.payload.eof);
  // The older, larger pin is still there at its own address.
  assert.ok(listOut(out).includes(`${first.payload.eof}-${first.payload.sha256_prefix.slice(0, 12)}.json`));
});

// ===========================================================================
// (n) WRITE-ONCE AT THE ADDRESS — a moving torn tail may not move the pin.
// ===========================================================================
test("n: the content-addressed pin is byte-identical under a moving torn tail; only latest.json's observation changes", async () => {
  const { ledger, out } = fixture("n-writeonce");
  writeFileSync(ledger, row("n1", "fact") + row("n2", "fact"));

  const first = await pinLedgerSnapshot({ ledgerPath: ledger, outDir: out });
  assert.equal(first.ok, true);
  const addressedBytes = readFileSync(first.snapshotPath);
  const size1 = statSync(ledger).size;

  // A writer starts a row and stops mid-flight. eof does not move; size does.
  const tornTail = '{"id":"n3","kind":"fa';
  appendFileSync(ledger, tornTail);

  const second = await pinLedgerSnapshot({ ledgerPath: ledger, outDir: out });
  assert.equal(second.ok, true, `pin aborted: ${second.reason} ${second.detail}`);
  assert.equal(second.snapshotPath, first.snapshotPath, "same prefix => same address");
  assert.equal(second.rewrote, false, "an address already pinned is never rewritten");
  assert.deepEqual(
    readFileSync(second.snapshotPath),
    addressedBytes,
    "the addressed file must be byte-identical — the address determines the content",
  );

  // latest.json is where the movement is recorded.
  const latest = JSON.parse(readFileSync(second.latestPath, "utf8"));
  assert.equal(first.payload.observation.torn_tail_bytes, 0);
  assert.equal(latest.observation.size, size1 + tornTail.length);
  assert.equal(latest.observation.torn_tail_bytes, tornTail.length);
  assert.equal(latest.eof, first.payload.eof, "the address-determined fields did NOT move");
  assert.equal(latest.sha256_prefix, first.payload.sha256_prefix);
  assert.deepEqual(tmpResidue(out), []);
});

test("o: a contradictory pin already at the address aborts (pin-contradiction) and writes nothing", async () => {
  const { ledger, out } = fixture("o-contradiction");
  writeFileSync(ledger, row("o1", "fact") + row("o2", "policy"));
  const first = await pinLedgerSnapshot({ ledgerPath: ledger, outDir: out });
  assert.equal(first.ok, true);

  // Forge a pin at the SAME address claiming a different denominator.
  const forged = JSON.parse(readFileSync(first.snapshotPath, "utf8"));
  forged.line_count = 999;
  writeFileSync(first.snapshotPath, `${JSON.stringify(forged, null, 2)}\n`);
  const before = listOut(out).map((f) => [f, readFileSync(join(out, f), "utf8")]);

  const res = await pinLedgerSnapshot({ ledgerPath: ledger, outDir: out });
  assert.equal(res.ok, false, "identical eof + sha256 cannot honestly yield different counts");
  assert.equal(res.reason, "pin-contradiction");
  assert.match(res.detail, /line_count/);
  assert.deepEqual(
    listOut(out).map((f) => [f, readFileSync(join(out, f), "utf8")]),
    before,
    "a contradiction must not be resolved by overwriting",
  );
});

// ===========================================================================
// (p) THE VERIFICATION BOUND IS EMITTED, IN BOTH MODES.
// ===========================================================================
test("p: the payload states what was actually verified — whole prefix by default, the sampled fraction under --fast-verify", async () => {
  const { ledger, out } = fixture("p-verify");
  const { sampledCount } = writeBigFixture(ledger);

  const full = await pinLedgerSnapshot({ ledgerPath: ledger, outDir: out });
  assert.equal(full.ok, true);
  assert.equal(
    (full.payload.verification ?? {}).method,
    "sha256-full-prefix-rescan",
    "every run must state what it actually verified",
  );
  assert.equal(
    full.payload.verification.prefix_bytes_verified,
    full.payload.eof,
    "the default mode verifies every byte of the prefix, and must say so",
  );
  assert.ok(full.payload.verification.witness_bytes_verified < full.payload.eof);
  assert.match(full.payload.verification.residual_note, /change made and reverted/);
  assert.deepEqual(full.payload.relaxed, []);

  const fastOut = join(out, "..", "p-fast");
  const fast = await pinLedgerSnapshot({ ledgerPath: ledger, outDir: fastOut, fastVerify: true });
  assert.equal(fast.ok, true);
  assert.equal(fast.payload.verification.method, "sampled-witness");
  assert.ok(fast.payload.verification.prefix_bytes_verified < fast.payload.eof);
  // The fraction is MEASURED, not asserted: the witness is exactly the
  // sampled blocks, so on this 80-block fixture it is 41/80 ≈ 51%. On the
  // live 2.9 GB ledger the same formula yields ~0.15% — which is precisely
  // why the payload must state it instead of claiming whole-prefix coverage.
  assert.equal(fast.payload.verification.witness_bytes_verified, sampledCount * BLOCK_BYTES);
  assert.equal(
    fast.payload.verification.witness_fraction,
    Number(((sampledCount * BLOCK_BYTES) / fast.payload.eof).toFixed(9)),
  );
  assert.ok(fast.payload.verification.witness_fraction < 1);

  // Both modes carry it in latest.json; neither puts it at the content
  // address (it describes the RUN, not the bytes).
  for (const r of [full, fast]) {
    const latest = JSON.parse(readFileSync(r.latestPath, "utf8"));
    assert.equal(typeof latest.verification.method, "string");
    assert.equal(typeof latest.verification.prefix_bytes_verified, "number");
    const addressed = JSON.parse(readFileSync(r.snapshotPath, "utf8"));
    assert.equal("verification" in addressed, false);
  }
  // Same prefix, two modes, ONE address and byte-identical content.
  assert.deepEqual(
    JSON.parse(readFileSync(full.snapshotPath, "utf8")),
    JSON.parse(readFileSync(fast.snapshotPath, "utf8")),
  );
});

// ===========================================================================
// CLI happy path — the Verify-block invocation shape actually works.
// ===========================================================================
test("cli: exits 0 and prints one JSON summary line", () => {
  const { ledger, out } = fixture("cli-ok");
  writeFileSync(ledger, row("z1", "fact") + row("z2", "fact"));
  const r = spawnSync(process.execPath, [SCRIPT, `--ledger=${ledger}`, `--out=${out}`], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  const summary = JSON.parse(lines[0]);
  assert.equal(summary.line_count, 2);
  assert.equal(summary.id_row_count, 2);
  assert.deepEqual(summary.kind_counts, { fact: 2 });
  assert.equal(summary.torn_tail_bytes, 0);
  assert.equal(summary.verification_method, "sha256-full-prefix-rescan");
  assert.equal(summary.prefix_bytes_verified, summary.eof);
  assert.ok(listOut(out).includes("latest.json"));
});

test("cli: rejects unknown args with exit 2 and writes nothing", () => {
  const { ledger, out } = fixture("cli-bad");
  writeFileSync(ledger, row("y1", "fact"));
  const r = spawnSync(process.execPath, [SCRIPT, "--nope"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.deepEqual(listOut(out), []);
});

// ===========================================================================
// LIVE arm — env-opt-in, DEFAULT-SKIPPED. `npm test` never pulls 2.9 GB
// through this suite.
// ===========================================================================
test(
  "live: pin the production ledger read-only (opt-in: MEMSYS_PIN_LIVE_LEDGER=1)",
  { skip: process.env.MEMSYS_PIN_LIVE_LEDGER !== "1" },
  async () => {
    const { out } = fixture("live");
    const ledger = join(PROD_LEDGERS, "memory.jsonl");
    const before = snap(ledger);
    const t0 = Date.now();
    const res = await pinLedgerSnapshot({ ledgerPath: ledger, outDir: out });
    const ms = Date.now() - t0;
    assert.equal(res.ok, true, `pin aborted: ${res.reason} ${res.detail}`);
    const p = res.payload;
    assert.ok(p.eof > 0 && p.eof <= p.observation.size);
    assert.equal(p.line_count, p.lines + p.skipped_blank + p.skipped_oversized);
    assert.ok(p.id_row_count > 0);
    assert.ok(Object.keys(p.kind_counts).length > 0);
    assert.equal(p.verification.method, "sha256-full-prefix-rescan");
    assert.equal(p.verification.prefix_bytes_verified, p.eof);
    // Read-only: the live ledger is stat-identical (nothing appended during
    // the run means this is exact; a concurrent append is reported, not hidden).
    assert.equal(snap(ledger), before, "the live pin must not touch the ledger");
    console.log(
      `  live pin: ${JSON.stringify(p.kind_counts)} eof=${p.eof} lines=${p.line_count} ` +
        `sha=${p.sha256_prefix} witness_fraction=${p.verification.witness_fraction} ${ms}ms`,
    );
  },
);

// ===========================================================================
// Hermeticity: production ledger, offset sidecar and indices/ untouched.
// ===========================================================================
test("hermeticity: production ledger, offsets sidecar and indices/ are stat-identical", () => {
  assert.deepEqual(PROD_PATHS.map(snap), PROD_BEFORE);
});
