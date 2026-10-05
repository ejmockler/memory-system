#!/usr/bin/env node
// pin-ledger-snapshot.mjs — A3: pin a REPRODUCIBLE ledger snapshot.
//
// WHY THIS EXISTS
//   Coverage claims ("BM25 indexes 96% of the ledger", "the offset sidecar
//   covers N rows") are unfalsifiable while the denominator is a moving
//   target: `ledgers/memory.jsonl` is a 2.9 GB append-only file with live
//   writers, so `wc -l` taken five minutes apart disagrees, and a writer
//   caught mid-append leaves a TORN FINAL LINE that inflates a naive
//   `grep -c '"id":'` by exactly one (measured: wc -l 1,516,636 vs
//   grep -c 1,516,637). This script freezes a denominator:
//
//     eof            — the newline-safe byte boundary (just past the last
//                      "\n"). Everything at/after it is a torn tail.
//     sha256_prefix  — sha256 over EXACTLY bytes [0, eof).
//     line_count     — newline-terminated rows in [0, eof) (== `wc -l`).
//     id_row_count   — rows in [0, eof) carrying a string `id`.
//     kind_counts    — histogram of the row `kind` field.
//
//   Because the ledger is append-only, a pin taken now stays valid forever:
//   appending moves neither the digest nor any count, since all five figures
//   are keyed on the pinned `eof`, never on `stat.size`. That is the whole
//   point, and `test/ledger-snapshot-pin.test.mjs` arm (b) makes it
//   falsifiable — a `stat.size` implementation fails that arm.
//
// FALSIFIED PREMISE (recorded per GOAL invariants 5 and 7)
//   The A3 spec asked for `type_counts`. LEDGER ROWS HAVE NO `type` FIELD.
//   Verified twice against the live ledger: `o.type === undefined` on 35/35
//   tail rows, on 283/283 rows of the trailing 20 MB, and on 55,985/55,985
//   mid-file rows. The discriminator is `kind` (fact / reconstructed /
//   policy). A `type_counts` field would have pinned an all-undefined
//   histogram — a vacuous number that no consumer could ever falsify. The
//   emitted field is therefore `kind_counts`. Sibling exposure: B1 consumes
//   this snapshot's line/eligible-row DENOMINATOR (`line_count` /
//   `id_row_count`), not the histogram, so B1 is unaffected by the rename.
//
// REUSE, NOT REIMPLEMENTATION (GOAL topology rule)
//   Every primitive comes from mcp/lib/synthesis/ledger-checkpoint.js:
//   captureCheckpoint / readAppended / verifyPrefix / emptyCheckpoint /
//   serializeCheckpoint, plus memoryLedgerPath() and LEDGERS_DIR from
//   mcp/lib/config.js. Neither module is modified. In particular the
//   whole-prefix sha256 is computed HERE and NOT pushed into
//   ledger-checkpoint.js: that module refuses whole-prefix hashing by design
//   (see its "HONEST LIMITATIONS" block, :70-72 — cost must stay O(witness)
//   regardless of file size) and its `hashRange` is deliberately unexported.
//
// WHY THE DIGEST IS ITS OWN READ PASS
//   The byte stream is NOT reconstructible from readAppended's callbacks:
//   blank lines and over-cap lines are counted but never delivered to
//   `onLine` (ledger-checkpoint.js:627-631), so a digest folded from the
//   callbacks would silently omit those bytes. Pass 1 hashes raw bytes
//   [0, eof); pass 2 counts rows. Two passes, one pinned boundary.
//
// WHAT VERIFICATION ACTUALLY GUARANTEES (and what it does not)
//   DEFAULT MODE ("sha256-full-prefix-rescan"). sha256 over [0, eof) is
//   computed twice: once before the counting pass and once after it (and
//   after the test-only afterScan seam). The run is published ONLY if the
//   two digests are byte-identical. The guarantee is therefore exactly:
//
//     the bytes of [0, eof) were identical immediately before and
//     immediately after the counting pass.
//
//   THE RESIDUAL, STATED HONESTLY: a change made and reverted ENTIRELY
//   inside that window is not detected. Nothing here is a lock; the ledger
//   has live writers. What is excluded is the failure this pin exists to
//   exclude — an in-place rewrite, rotation or compaction of the prefix
//   that leaves the pin claiming a denominator over bytes that no longer
//   exist. A CORRECTION IS RECORDED HERE: an earlier revision of this file
//   claimed the post-scan verifyPrefix "is what closes the TOCTOU window".
//   That was an overclaim. verifyPrefix re-reads only the SAMPLED witness
//   (<= 128 x 64 KiB, ~0.147% of the live 2.9 GB prefix), so a mutation
//   confined to unsampled interior blocks passed it undetected — proven by
//   test arm (h). verifyPrefix is retained as a CHEAP PRE-CHECK (it also
//   catches shrink / missing / inode change); the second full hash pass is
//   what actually decides.
//
//   --fast-verify OPTS BACK DOWN to the sampled witness alone. It is a
//   genuinely weaker mode and says so in the payload:
//   verification.method === "sampled-witness" with the honest
//   prefix_bytes_verified / witness_fraction, plus "fast-verify" in
//   `relaxed`. Test arm (h2) pins that the weaker mode really does miss the
//   mutation arm (h) catches — the bound is measured, not asserted.
//
// FAIL-CLOSED (GOAL inv 4 / node invariant 4)
//   Any of: captureCheckpoint returning null; an empty prefix (eof === 0 or
//   line_count === 0) without --allow-empty; an existing latest.json whose
//   eof is GREATER than this one's without --allow-rewind (the ledger is
//   append-only, so a rewind is a red flag, not a re-pin); a non-null
//   readAppended error (missing / truncated / torn-boundary / io-error /
//   invalid-*); a violated accounting identity; a kind histogram that does
//   not reconcile IN THE SERIALIZED BYTES; a failing verifyPrefix; a
//   post-scan digest that differs from the pre-scan digest; or an existing
//   pin at this address whose address-determined fields disagree — aborts
//   with a non-zero exit and writes NOTHING AT ALL. No partial file, no
//   latest.json flip, no touched byte. A partial or unverified pin is worse
//   than no pin: it launders an unknown denominator as a known one.
//
// TWO FILES, TWO DIFFERENT CONTRACTS
//   <eof>-<sha12>.json is CONTENT-ADDRESSED and WRITE-ONCE. It carries ONLY
//   address-determined fields — a pure function of the bytes [0, eof):
//   v, eof, sha256_prefix, line_count, id_row_count, kind_counts,
//   kind_bucket_overflow, unparseable_count, lines, skipped_blank,
//   skipped_oversized, bytes, skipped_oversized_bytes, max_line_bytes.
//   If the file already exists and those fields match, it is NOT rewritten
//   (`rewrote: false`); if they disagree, the run aborts `pin-contradiction`
//   — identical eof + sha256 cannot honestly yield different counts. (Note
//   `max_line_bytes` is in the set because the counts depend on it: re-
//   pinning the same prefix under a different cap IS a contradiction at
//   that address, and aborts rather than silently overwriting.)
//
//   latest.json is EXPLICITLY NOT CONTENT-ADDRESSED. It is the address-
//   determined payload PLUS `verification`, `relaxed`, and an `observation`
//   block holding everything volatile: captured_at, ledger_path, size,
//   torn_tail_bytes and the serialized checkpoint (which itself carries
//   size / mtimeMs / ino). Those move under a live writer while the address
//   does not, which is precisely why they may not live at the address.
//
// SAFETY (GOAL inv 1 and 2)
//   memory.jsonl is opened "r" ONLY — never written, truncated, compacted or
//   rotated. `memory.jsonl.offsets` and `indices/` are NEVER read or touched.
//   The pin is a NEW side-by-side artifact under `ledgers/snapshots/`, and
//   both output files are published tmp + renameSync WITHIN that directory,
//   so `latest.json` flips atomically and a crashed run leaves no partial
//   file (the tmp is unlinked on failure).
//
// USAGE
//   node mcp/scripts/pin-ledger-snapshot.mjs
//   node mcp/scripts/pin-ledger-snapshot.mjs --ledger=<path> --out=<dir>
//   node mcp/scripts/pin-ledger-snapshot.mjs --max-line-bytes=<n> --quiet
//   node mcp/scripts/pin-ledger-snapshot.mjs --fast-verify   (weaker; stamped)
//   node mcp/scripts/pin-ledger-snapshot.mjs --allow-empty --allow-rewind
//
// OUTPUT
//   <out>/<eof>-<sha256[0:12]>.json  — write-once, address-determined only
//   <out>/latest.json                — superset, atomically swapped each run
//   One JSON summary line on stdout (suppressed by --quiet).
//
// EXIT CODES
//   0 — pin written (or left in place byte-identically).
//   1 — fail-closed abort. NOTHING was created or replaced.
//   2 — bad CLI arguments.
//
// DISCIPLINE: ESM, Node stdlib only. Additive: no existing behavior changes,
// nothing is wired into a hot path or a daemon, no export is added to
// config.js, and ledger-checkpoint.js is untouched.

import { createReadStream, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { LEDGERS_DIR, memoryLedgerPath } from "../lib/config.js";
import {
  captureCheckpoint,
  emptyCheckpoint,
  readAppended,
  serializeCheckpoint,
  verifyPrefix,
} from "../lib/synthesis/ledger-checkpoint.js";

/** Snapshot payload schema version. v2 split address-determined from observed. */
export const SNAPSHOT_VERSION = 2;

/** Bucket for a parsed row that carries no usable `kind`. Never dropped. */
export const MISSING_KIND = "<missing>";

/** Bucket for a parsed row whose `kind` is present but not a string. */
export const NON_STRING_KIND = "<non-string>";

/** Bucket for a `kind` string longer than MAX_KIND_BYTES. Never dropped. */
export const OVERSIZED_KIND = "<oversized-kind>";

/** Bucket absorbing every kind past MAX_KIND_BUCKETS. Never dropped. */
export const OTHER_KIND = "<other>";

/**
 * Cardinality cap on the kind histogram. A hostile or buggy writer emitting
 * a unique `kind` per row must not turn a bounded pin into an unbounded one;
 * past the cap, kinds fold into OTHER_KIND and `kind_bucket_overflow` is
 * true. At most MAX_KIND_BUCKETS named buckets, plus OTHER_KIND.
 */
export const MAX_KIND_BUCKETS = 256;

/** Longest `kind` kept verbatim, in UTF-8 bytes. Longer folds to OVERSIZED_KIND. */
export const MAX_KIND_BYTES = 64;

/**
 * Fields that are a PURE FUNCTION of the bytes [0, eof). Exactly these are
 * written to the content-addressed file, and exactly these are compared to
 * decide rewrote / pin-contradiction. Order is the emitted key order.
 */
export const ADDRESS_FIELDS = [
  "v",
  "eof",
  "sha256_prefix",
  "line_count",
  "id_row_count",
  "kind_counts",
  "kind_bucket_overflow",
  "unparseable_count",
  "lines",
  "skipped_blank",
  "skipped_oversized",
  "bytes",
  "skipped_oversized_bytes",
  "max_line_bytes",
];

const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024; // parity with readAppended

const RESIDUAL_FULL =
  "sha256 over [0, eof) was byte-identical immediately before and immediately " +
  "after the counting pass. NOT detected: a change made and reverted entirely " +
  "inside that window.";

const RESIDUAL_SAMPLED =
  "--fast-verify: only the sampled witness blocks were re-read after the " +
  "counting pass. NOT detected: any change confined to unsampled interior " +
  "blocks (see witness_fraction for the measured coverage).";

// ---------------------------------------------------------------------------
// Pass 1 / pass 3 — sha256 over EXACTLY bytes [0, eof).
//
// A dedicated raw-byte pass (see the header note): readAppended never hands
// blank or oversized lines to onLine, so hashing from its callbacks would
// silently omit those bytes. `end` is INCLUSIVE in createReadStream, hence
// eof - 1. eof === 0 is the empty-prefix digest, computed without any I/O.
// The SAME helper is re-run after the counting pass; byte equality of the two
// digests is what the default mode publishes on.
// ---------------------------------------------------------------------------
function sha256Prefix(path, eof) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    if (eof === 0) {
      resolve(hash.digest("hex"));
      return;
    }
    const rs = createReadStream(path, { start: 0, end: eof - 1 });
    let got = 0;
    rs.on("data", (chunk) => {
      got += chunk.length;
      hash.update(chunk);
    });
    rs.on("error", reject);
    rs.on("end", () => {
      if (got !== eof) {
        // Short read: the file shrank under us mid-pass. Fail closed rather
        // than emit a digest over fewer bytes than the pin claims.
        reject(new Error(`short-read: hashed ${got} of ${eof} bytes`));
        return;
      }
      resolve(hash.digest("hex"));
    });
  });
}

// ---------------------------------------------------------------------------
// Pass 2 — counts over EXACTLY [0, eof), via the tested delta primitive.
//
// readAppended(path, emptyCheckpoint(), cp, onLine) is the sanctioned
// replay-from-byte-0 form (ledger-checkpoint.js:702-707). Every DELIVERED
// row is parsed and bucketed; a row that fails JSON.parse lands in
// `unparseable_count` and a row without a usable `kind` lands in an explicit
// bucket — NOTHING is ever dropped silently, including under a hostile
// writer: `kind` values that are absurdly long, absurdly numerous, or named
// after Object.prototype members ("__proto__", "constructor", "toString")
// all land in a real, countable bucket. The histogram is built on a
// null-prototype object so an inherited member can never be mistaken for a
// count.
// ---------------------------------------------------------------------------
function countPrefixRows(path, cp, maxLineBytes) {
  const kindCounts = Object.create(null);
  let distinct = 0;
  let overflow = false;
  let idRowCount = 0;
  let unparseable = 0;

  const stats = readAppended(
    path,
    emptyCheckpoint(),
    cp,
    (text) => {
      let row;
      try {
        row = JSON.parse(text);
      } catch {
        unparseable += 1;
        return;
      }
      const isObject = row !== null && typeof row === "object" && !Array.isArray(row);
      if (isObject && typeof row.id === "string") idRowCount += 1;
      let bucket;
      if (isObject && typeof row.kind === "string") {
        bucket =
          Buffer.byteLength(row.kind, "utf8") > MAX_KIND_BYTES ? OVERSIZED_KIND : row.kind;
      } else if (!isObject || row.kind === undefined || row.kind === null) {
        bucket = MISSING_KIND;
      } else {
        bucket = NON_STRING_KIND;
      }
      if (kindCounts[bucket] === undefined && distinct >= MAX_KIND_BUCKETS) {
        bucket = OTHER_KIND;
        overflow = true;
      }
      if (kindCounts[bucket] === undefined) {
        distinct += 1;
        kindCounts[bucket] = 0;
      }
      kindCounts[bucket] += 1;
    },
    { maxLineBytes },
  );

  return { stats, kindCounts, overflow, idRowCount, unparseable };
}

/**
 * Deterministic key order so re-pins are byte-identical.
 *
 * The accumulator is Object.create(null), NOT {}. On a plain object
 * `out["__proto__"] = 3` is a silent no-op (the setter rejects a non-object),
 * so a row whose kind is literally "__proto__" would vanish from the emitted
 * histogram while still being counted internally — the published sum and the
 * internal sum would disagree, and nothing would say so. A null-prototype
 * object makes "__proto__" an ordinary own property that JSON.stringify emits
 * and JSON.parse round-trips.
 */
function sortedCounts(counts) {
  const out = Object.create(null);
  for (const k of Object.keys(counts).sort()) out[k] = counts[k];
  return out;
}

// ---------------------------------------------------------------------------
// Atomic publish: tmp + renameSync within the SAME directory (never across
// filesystems, so the rename is a true atomic swap). The tmp is unlinked on
// any failure, so no `.tmp-*` residue survives a crashed run.
// ---------------------------------------------------------------------------
function writeAtomic(dir, name, text) {
  const tmp = join(
    dir,
    `.${name}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, join(dir, name));
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
    throw err;
  }
}

function readJsonIfPresent(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Canonical, comparable form of the address-determined fields. Used ONLY to
 * decide rewrote vs pin-contradiction, so it must be insensitive to key order
 * and whitespace and sensitive to every value.
 */
function canonicalAddress(obj) {
  if (obj === null || typeof obj !== "object") return null;
  const out = Object.create(null);
  for (const k of ADDRESS_FIELDS) {
    const v = obj[k];
    out[k] = k === "kind_counts" && v !== null && typeof v === "object" ? sortedCounts(v) : v;
  }
  return JSON.stringify(out);
}

/** Address fields that differ between two payload-shaped objects. */
function differingAddressFields(a, b) {
  const diff = [];
  const norm = (o, k) => {
    const v = o === null || typeof o !== "object" ? undefined : o[k];
    if (k !== "kind_counts") return JSON.stringify(v);
    return JSON.stringify(sortedCounts(v !== null && typeof v === "object" ? v : {}));
  };
  for (const k of ADDRESS_FIELDS) if (norm(a, k) !== norm(b, k)) diff.push(k);
  return diff;
}

/**
 * THE ROW-ACCOUNTING GUARD, RUN ON THE SERIALIZED BYTES.
 *
 * Checking the in-memory histogram proves nothing about what a consumer will
 * read: serialization is exactly where a hostile key can disappear. This
 * re-PARSES the text that is about to be written and reconciles it there.
 * Returns null when sum(kind_counts) + unparseable_count === lines in the
 * emitted JSON, or a human detail string otherwise.
 */
function serializedAccountingViolation(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return `serialized payload does not parse: ${String(err && err.message)}`;
  }
  const kc = parsed.kind_counts;
  if (kc === null || typeof kc !== "object" || Array.isArray(kc)) {
    return "serialized payload has no kind_counts object";
  }
  let bucketed = 0;
  for (const k of Object.keys(kc)) {
    const v = kc[k];
    if (!Number.isInteger(v) || v < 0) {
      return `serialized kind_counts[${JSON.stringify(k)}] is not a count: ${JSON.stringify(v)}`;
    }
    bucketed += v;
  }
  if (!Number.isInteger(parsed.unparseable_count) || !Number.isInteger(parsed.lines)) {
    return "serialized payload is missing lines / unparseable_count";
  }
  if (bucketed + parsed.unparseable_count !== parsed.lines) {
    return `serialized kind_counts(${bucketed}) + unparseable(${parsed.unparseable_count}) != lines(${parsed.lines})`;
  }
  return null;
}

/**
 * pinLedgerSnapshot — capture, hash, count, re-hash, publish.
 *
 * @param {object} [opts]
 * @param {string} [opts.ledgerPath] — defaults to memoryLedgerPath().
 * @param {string} [opts.outDir]     — defaults to LEDGERS_DIR/snapshots.
 * @param {number} [opts.maxLineBytes] — readAppended line cap (default 8 MiB).
 * @param {boolean} [opts.fastVerify] — skip the post-scan full rescan and
 *   verify only the sampled witness. Weaker; stamped into the payload.
 * @param {boolean} [opts.allowEmpty] — permit a vacuous (0-row) pin.
 * @param {boolean} [opts.allowRewind] — permit latest.json to move backwards.
 * @param {object} [opts.hooks] — VERIFICATION SEAM, never set in production.
 *   `hooks.afterScan()` fires after BOTH read passes and BEFORE any post-scan
 *   verification. It exists so the verification bound is falsifiable: a test
 *   mutates a byte inside [0, eof) there and asserts the run aborts with no
 *   file written. `hooks.beforeSerialize({addressPayload, latestPayload})`
 *   fires immediately before serialization so the post-serialization
 *   accounting guard is falsifiable too. The CLI below never passes either;
 *   no production caller does.
 * @returns {Promise<{ok: true, payload: object, addressPayload: object,
 *   snapshotPath: string, latestPath: string, rewrote: boolean} |
 *   {ok: false, reason: string, detail: string|null}>}
 *   `payload` is the RE-PARSED text written to latest.json — the returned
 *   object is the emitted bytes, not a hopeful copy of them. On `ok: false`
 *   NOTHING was written. Never throws for expected failure modes; a
 *   genuinely unexpected fs error propagates.
 */
export async function pinLedgerSnapshot(opts = {}) {
  const ledgerPath =
    typeof opts.ledgerPath === "string" && opts.ledgerPath.length > 0
      ? opts.ledgerPath
      : memoryLedgerPath();
  const outDir =
    typeof opts.outDir === "string" && opts.outDir.length > 0
      ? opts.outDir
      : join(LEDGERS_DIR, "snapshots");
  const maxLineBytes =
    Number.isInteger(opts.maxLineBytes) && opts.maxLineBytes > 0
      ? opts.maxLineBytes
      : DEFAULT_MAX_LINE_BYTES;
  const fastVerify = opts.fastVerify === true;
  const allowEmpty = opts.allowEmpty === true;
  const allowRewind = opts.allowRewind === true;

  const relaxed = [];
  if (fastVerify) relaxed.push("fast-verify");
  if (allowEmpty) relaxed.push("allow-empty");
  if (allowRewind) relaxed.push("allow-rewind");

  const latestPath = join(outDir, "latest.json");

  // --- Step 1: pin the boundary. -------------------------------------------
  const cp = captureCheckpoint(ledgerPath);
  if (cp === null) {
    return { ok: false, reason: "capture-failed", detail: ledgerPath };
  }
  const eof = cp.eof;
  const size = cp.size;
  const tornTailBytes = size - eof; // reported, NEVER parsed or hashed

  // --- Step 1a: refuse a vacuous pin. --------------------------------------
  // An eof of 0 means "no newline-terminated byte exists yet". Publishing it
  // hands a consumer a denominator of zero that LOOKS pinned, and worse, the
  // latest.json flip would clobber a real pin with it.
  if (eof === 0 && !allowEmpty) {
    return {
      ok: false,
      reason: "empty-prefix",
      detail: `eof(0) — no newline-terminated prefix to pin (size ${size}); pass --allow-empty to force`,
    };
  }

  // --- Step 1b: refuse a rewind. -------------------------------------------
  // memory.jsonl is append-only, so a new eof BELOW the published one is a
  // symptom (truncation, rotation, wrong --ledger), never a re-pin.
  const existingLatest = readJsonIfPresent(latestPath);
  if (
    !allowRewind &&
    existingLatest !== null &&
    Number.isInteger(existingLatest.eof) &&
    existingLatest.eof > eof
  ) {
    return {
      ok: false,
      reason: "latest-rewind",
      detail: `latest.json eof(${existingLatest.eof}) > new eof(${eof}) on an append-only ledger; pass --allow-rewind to force`,
    };
  }

  // --- Step 2: sha256 of exactly [0, eof). ---------------------------------
  let sha;
  try {
    sha = await sha256Prefix(ledgerPath, eof);
  } catch (err) {
    return { ok: false, reason: "hash-failed", detail: String(err && err.message) };
  }

  // --- Step 3: counts over exactly [0, eof). -------------------------------
  const { stats, kindCounts, overflow, idRowCount, unparseable } = countPrefixRows(
    ledgerPath,
    cp,
    maxLineBytes,
  );
  if (stats.error !== null) {
    return { ok: false, reason: "scan-failed", detail: stats.error };
  }

  // --- Step 4: honest line accounting. -------------------------------------
  // readAppended.lines counts DELIVERED lines only. The `wc -l`-comparable
  // figure adds back the two documented skip classes, and the module's own
  // accounting identity is asserted so the total cannot silently drift.
  const identityLhs = stats.bytes + stats.skipped_oversized_bytes + stats.skipped_blank;
  if (identityLhs !== eof) {
    return {
      ok: false,
      reason: "accounting-identity-violated",
      detail: `bytes(${stats.bytes}) + oversized_bytes(${stats.skipped_oversized_bytes}) + blank(${stats.skipped_blank}) = ${identityLhs} != eof(${eof})`,
    };
  }
  const lineCount = stats.lines + stats.skipped_blank + stats.skipped_oversized;

  if (lineCount === 0 && !allowEmpty) {
    return {
      ok: false,
      reason: "empty-prefix",
      detail: `line_count(0) over eof(${eof}) — a zero-row denominator is not a pin; pass --allow-empty to force`,
    };
  }

  // (The row-accounting guard is NOT here. It runs on the SERIALIZED bytes at
  // step 7 — checking the in-memory histogram cannot see a key that
  // serialization drops.)

  // --- Step 5: verify the prefix did not move under the scan. --------------
  // (Step ordering note: the type -> kind correction is step 0; see header.)
  if (opts.hooks && typeof opts.hooks.afterScan === "function") {
    await opts.hooks.afterScan({ ledgerPath, cp, sha, lineCount });
  }

  // 5a. Cheap pre-check: catches shrink, deletion, inode change and any
  //     mutation that happens to land in a sampled block, for <= 8 MiB of
  //     reads. It is NOT the whole-prefix guarantee — see the header.
  const pv = verifyPrefix(ledgerPath, cp);
  if (!pv.ok) {
    return { ok: false, reason: "prefix-drift", detail: pv.reason };
  }

  // 5b. The decision: re-hash the WHOLE prefix and demand byte equality.
  //     Same helper, same range — no second hashing implementation exists.
  if (!fastVerify) {
    let sha2;
    try {
      sha2 = await sha256Prefix(ledgerPath, eof);
    } catch (err) {
      return { ok: false, reason: "hash-failed", detail: `rescan: ${String(err && err.message)}` };
    }
    if (sha2 !== sha) {
      return {
        ok: false,
        reason: "prefix-drift",
        detail: `sha256[0,${eof}) moved during the scan: ${sha} -> ${sha2}`,
      };
    }
  }

  const witnessBytes = cp.witness.reduce((acc, e) => acc + e.len, 0);
  const verification = {
    method: fastVerify ? "sampled-witness" : "sha256-full-prefix-rescan",
    prefix_bytes_verified: fastVerify ? witnessBytes : eof,
    witness_bytes_verified: witnessBytes,
    witness_fraction: eof === 0 ? 0 : Number((witnessBytes / eof).toFixed(9)),
    residual_note: fastVerify ? RESIDUAL_SAMPLED : RESIDUAL_FULL,
  };

  // --- Step 6: build the two payloads. -------------------------------------
  // addressPayload is a pure function of [0, eof). Everything that moves
  // under a live writer lives in `observation`, which latest.json alone
  // carries — see "TWO FILES, TWO DIFFERENT CONTRACTS" in the header.
  const addressPayload = {
    v: SNAPSHOT_VERSION,
    eof,
    sha256_prefix: sha,
    line_count: lineCount,
    id_row_count: idRowCount,
    kind_counts: sortedCounts(kindCounts),
    kind_bucket_overflow: overflow,
    unparseable_count: unparseable,
    // Components of line_count, plus the two byte figures, so a consumer can
    // re-derive BOTH the line total and the module's accounting identity
    // (bytes + skipped_oversized_bytes + skipped_blank === eof) from the
    // payload alone, without re-reading the ledger.
    lines: stats.lines,
    skipped_blank: stats.skipped_blank,
    skipped_oversized: stats.skipped_oversized,
    bytes: stats.bytes,
    skipped_oversized_bytes: stats.skipped_oversized_bytes,
    max_line_bytes: maxLineBytes,
  };

  const latestPayload = {
    ...addressPayload,
    verification,
    relaxed,
    observation: {
      captured_at: new Date().toISOString(),
      ledger_path: ledgerPath,
      size,
      torn_tail_bytes: tornTailBytes,
      // Embedding the serialized checkpoint lets a consumer re-verify this pin
      // in O(witness) bytes (<= 8 MiB) instead of rescanning 2.9 GB. It
      // carries size / mtimeMs / ino, so it is an OBSERVATION, not an address.
      checkpoint: serializeCheckpoint(cp),
    },
  };

  // --- Step 7: the row-accounting guard, on the bytes about to be written. -
  // The seam below exists so that guard is FALSIFIABLE: arm (j2) corrupts the
  // histogram here and asserts the run aborts with nothing written. Test-only,
  // exactly like hooks.afterScan; the CLI never passes it.
  if (opts.hooks && typeof opts.hooks.beforeSerialize === "function") {
    await opts.hooks.beforeSerialize({ addressPayload, latestPayload });
  }
  const addressText = `${JSON.stringify(addressPayload, null, 2)}\n`;
  const latestText = `${JSON.stringify(latestPayload, null, 2)}\n`;
  for (const [what, text] of [
    ["addressed", addressText],
    ["latest", latestText],
  ]) {
    const violation = serializedAccountingViolation(text);
    if (violation !== null) {
      return {
        ok: false,
        reason: "serialized-accounting-violated",
        detail: `${what}: ${violation}`,
      };
    }
  }

  // --- Step 8: WRITE-ONCE at the address. ----------------------------------
  const name = `${eof}-${sha.slice(0, 12)}.json`;
  const snapshotPath = join(outDir, name);
  const existing = readJsonIfPresent(snapshotPath);
  let rewrote = true;
  if (existing !== null) {
    if (canonicalAddress(existing) === canonicalAddress(addressPayload)) {
      rewrote = false; // already pinned, byte-for-byte in every address field
    } else {
      return {
        ok: false,
        reason: "pin-contradiction",
        detail: `${name} exists with different address-determined fields: ${
          differingAddressFields(existing, addressPayload).join(", ") || "(shape)"
        }`,
      };
    }
  }

  mkdirSync(outDir, { recursive: true });
  if (rewrote) writeAtomic(outDir, name, addressText);
  writeAtomic(outDir, "latest.json", latestText);

  return {
    ok: true,
    payload: JSON.parse(latestText),
    addressPayload: JSON.parse(addressText),
    snapshotPath,
    latestPath,
    rewrote,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `pin-ledger-snapshot.mjs — pin a reproducible ledger snapshot.

  node mcp/scripts/pin-ledger-snapshot.mjs [options]

  --ledger=<path>         ledger to pin  (default: config memoryLedgerPath())
  --out=<dir>             output dir     (default: <LEDGERS_DIR>/snapshots)
  --max-line-bytes=<n>    readAppended line cap (default: 8388608)
  --fast-verify           verify only the sampled witness instead of re-hashing
                          the whole prefix. WEAKER: stamps verification.method
                          "sampled-witness" and the measured witness_fraction.
  --allow-empty           permit a 0-row pin (default: fail closed)
  --allow-rewind          permit latest.json to move to a SMALLER eof
  --quiet                 suppress the stdout summary line
  -h, --help              this text

Writes <out>/<eof>-<sha12>.json (write-once, address-determined fields only)
and <out>/latest.json (superset: + verification, relaxed, observation), both
tmp + rename. Reads the ledger "r" only; never touches memory.jsonl.offsets
or indices/. Exit 0 = pinned, 1 = fail-closed abort (nothing written), 2 = bad
args.
`;

export function parseArgs(argv) {
  const opts = { quiet: false };
  for (const a of argv) {
    if (a === "--help" || a === "-h") return { help: true };
    else if (a === "--quiet") opts.quiet = true;
    else if (a === "--fast-verify") opts.fastVerify = true;
    else if (a === "--allow-empty") opts.allowEmpty = true;
    else if (a === "--allow-rewind") opts.allowRewind = true;
    else if (a.startsWith("--ledger=")) opts.ledgerPath = a.slice("--ledger=".length);
    else if (a.startsWith("--out=")) opts.outDir = a.slice("--out=".length);
    else if (a.startsWith("--max-line-bytes=")) {
      const n = Number(a.slice("--max-line-bytes=".length));
      if (!Number.isInteger(n) || n <= 0) return { error: `bad --max-line-bytes: ${a}` };
      opts.maxLineBytes = n;
    } else return { error: `unknown arg: ${a}` };
  }
  return { opts };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (parsed.error) {
    process.stderr.write(`pin-ledger-snapshot: ${parsed.error}\n\n${HELP}`);
    return 2;
  }
  const started = Date.now();
  const res = await pinLedgerSnapshot(parsed.opts);
  if (!res.ok) {
    process.stderr.write(
      `pin-ledger-snapshot: ABORTED (${res.reason}${res.detail ? `: ${res.detail}` : ""}) — no snapshot written\n`,
    );
    return 1;
  }
  if (!parsed.opts.quiet) {
    const p = res.payload;
    process.stdout.write(
      `${JSON.stringify({
        snapshot_path: res.snapshotPath,
        latest_path: res.latestPath,
        size: p.observation.size,
        eof: p.eof,
        torn_tail_bytes: p.observation.torn_tail_bytes,
        sha256_prefix: p.sha256_prefix,
        line_count: p.line_count,
        id_row_count: p.id_row_count,
        kind_counts: p.kind_counts,
        kind_bucket_overflow: p.kind_bucket_overflow,
        unparseable_count: p.unparseable_count,
        verification_method: p.verification.method,
        prefix_bytes_verified: p.verification.prefix_bytes_verified,
        relaxed: p.relaxed,
        rewrote: res.rewrote,
        duration_ms: Date.now() - started,
      })}\n`,
    );
  }
  return 0;
}

// Main-module detection. A file:// string hand-built from argv[1] is WRONG: a
// path containing a space (or "#", "?", "%") percent-encodes in
// import.meta.url but not in the template, so the guard silently goes false
// and the CLI exits 0 having done nothing. Comparing REAL filesystem paths
// handles the encoding and a symlinked invocation path alike. Arm (i) runs
// the script from a directory whose name has a space.
const INVOKED_DIRECTLY = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (INVOKED_DIRECTLY) {
  process.exitCode = await main();
}
