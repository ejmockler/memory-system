// queryd-protocol-framedecoder.test.mjs — FrameDecoder reassembly: copy
// budget, retention bound, aliasing, behavioural parity, and a recorded perf
// probe on a real vector_fetch-shaped response frame.
//
// RED-FIRST NOTE: written against the UNMODIFIED decoder, whose
// `Buffer.concat([this._buf, chunk])`-per-chunk reassembly moves O(N^2) bytes.
// T1 (copy budget) and T6 (declare-and-stall pin) are the graded assertions:
// T1 fails red (~512x on an 8 MiB frame); T6 guards the FIX (naive
// preallocation would pin the 32 MiB cap per connection), so it passes both
// before and after by design. T4 is pure parity — every check in it passes on
// the unmodified decoder and must keep passing.
//
// Discipline (matches test/daemon/queryd.test.mjs):
//   - node:test + node:assert/strict; hermetic — no daemon, no socket, no
//     live index, no filesystem. Pure in-process buffer work.
//   - frames are built with the REAL encodeFrame except where a malformed
//     wire frame is deliberately hand-rolled.
//   - the copy-budget spies patch globals (Buffer.concat,
//     Buffer.prototype.copy, Uint8Array.prototype.set) and restore all three
//     in a try/finally. This is valid because queryd-protocol.js has no
//     imports at all and resolves Buffer from the global at call time.

import test from "node:test";
import assert from "node:assert/strict";

import {
  encodeFrame,
  FrameDecoder,
  ERROR_CODES,
  MAX_OUTBOUND_FRAME_BYTES,
} from "../../daemon/queryd-protocol.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Feed `frame` to `dec` in fixed-size slices; return every frame decoded. */
function feedInSlices(dec, frame, sliceBytes) {
  const got = [];
  for (let i = 0; i < frame.length; i += sliceBytes) {
    const { frames, error } = dec.push(frame.subarray(i, i + sliceBytes));
    assert.equal(error, null, `unexpected error at offset ${i}`);
    got.push(...frames);
  }
  return got;
}

/**
 * Every Buffer the decoder retains, reachable from its OWN properties
 * (directly, or inside an array-valued property). This is the shape the
 * retention assertions walk — it deliberately rejects a chunk-list
 * accumulator, which retains one Buffer per chunk.
 */
function retainedBuffers(dec) {
  const out = [];
  for (const v of Object.values(dec)) {
    if (Buffer.isBuffer(v)) out.push(v);
    else if (Array.isArray(v)) {
      for (const e of v) if (Buffer.isBuffer(e)) out.push(e);
    }
  }
  return out;
}

/** Concatenated hex of every retained Buffer — used for residue checks. */
function retainedHex(dec) {
  return retainedBuffers(dec)
    .map((b) => b.toString("hex"))
    .join("|");
}

/** Hand-rolled 4-byte BE length prefix (deliberately malformed wire input). */
function prefixOf(n) {
  const p = Buffer.alloc(4);
  p.writeUInt32BE(n, 0);
  return p;
}

/** Deterministic full-precision doubles (mulberry32 / PI keeps 53 mantissa bits). */
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5) / Math.PI;
  };
}

// ---------------------------------------------------------------------------
// T1 — COPY BUDGET (the RED). Deterministic, no clock.
// ---------------------------------------------------------------------------
test("T1 copy budget: decoding an N-byte frame moves O(N) bytes", (t) => {
  const payload = "x".repeat(8 * 1024 * 1024 - 10);
  const frame = encodeFrame({ pad: payload }, { maxBytes: MAX_OUTBOUND_FRAME_BYTES });

  let moved = 0;
  let got = [];

  // Three spies, not two: Buffer extends Uint8Array, so an implementation
  // using body.set(...) instead of chunk.copy(...) would register ZERO bytes
  // under a concat+copy-only spy and pass this assertion vacuously.
  const origConcat = Buffer.concat;
  const origCopy = Buffer.prototype.copy;
  const origSet = Uint8Array.prototype.set;
  try {
    Buffer.concat = function (list, totalLength) {
      let n = 0;
      for (let i = 0; i < list.length; i++) n += list[i].length;
      moved += totalLength === undefined ? n : Math.min(n, totalLength);
      return origConcat.call(Buffer, list, totalLength);
    };
    Buffer.prototype.copy = function (target, ts, ss, se) {
      const n = origCopy.call(this, target, ts, ss, se);
      moved += n;
      return n;
    };
    Uint8Array.prototype.set = function (arr, offset) {
      if (arr != null && typeof arr.length === "number") moved += arr.length;
      return origSet.call(this, arr, offset);
    };

    const dec = new FrameDecoder({ maxFrameBytes: MAX_OUTBOUND_FRAME_BYTES });
    got = feedInSlices(dec, frame, 8192);
  } finally {
    Buffer.concat = origConcat;
    Buffer.prototype.copy = origCopy;
    Uint8Array.prototype.set = origSet;
  }

  const ratio = moved / frame.length;
  t.diagnostic(
    `T1: frame=${frame.length} B fed in 8192 B slices; bytes moved=${moved} (${ratio.toFixed(1)}x)`,
  );

  // The budget cannot be met by simply not decoding.
  assert.equal(got.length, 1, "exactly one frame must decode");
  assert.equal(got[0].pad, payload, "frame body must round-trip intact");

  // Non-vacuity positive control: the decoder MUST be observed moving the
  // bytes at least once. A metric that observes nothing proves nothing.
  assert.ok(
    moved >= frame.length,
    `non-vacuity: spies observed only ${moved} bytes for a ${frame.length}-byte frame — the metric is blind`,
  );

  // The defect assertion. 4x, not 1.5x: the doubling-growth body buffer costs
  // ~1.99x by design and must not be rejected.
  assert.ok(
    moved <= 4 * frame.length,
    `copy budget: moved ${moved} bytes decoding a ${frame.length}-byte frame ` +
      `(${ratio.toFixed(1)}x); budget is <= ${4 * frame.length} bytes (4.0x)`,
  );
});

// ---------------------------------------------------------------------------
// T2 — RETENTION IS O(1) BUFFERS, NOT O(CHUNKS).
// ---------------------------------------------------------------------------
test("T2 retention: an incomplete frame pins O(1) buffers, not one per chunk", (t) => {
  const payload = "y".repeat(1024 * 1024 - 10);
  const frame = encodeFrame({ pad: payload }, { maxBytes: MAX_OUTBOUND_FRAME_BYTES });

  const dec = new FrameDecoder({ maxFrameBytes: MAX_OUTBOUND_FRAME_BYTES });
  // Stop ONE BYTE SHORT: the frame never completes, so whatever the decoder
  // is holding is still held when we count.
  const stall = frame.subarray(0, frame.length - 1);
  for (let i = 0; i < stall.length; i += 64) {
    const { frames, error } = dec.push(stall.subarray(i, i + 64));
    assert.equal(error, null);
    assert.equal(frames.length, 0);
  }

  let n = 0;
  for (const v of Object.values(dec)) {
    if (Buffer.isBuffer(v)) n += 1;
    else if (Array.isArray(v)) n += v.filter(Buffer.isBuffer).length;
  }
  t.diagnostic(
    `T2: ${Math.ceil(stall.length / 64)} chunks in flight -> ${n} retained Buffer(s)`,
  );
  assert.ok(
    n <= 4,
    `retained ${n} Buffers for an incomplete frame fed in 64-byte chunks; ` +
      `bound is 4. A chunk-list accumulator retains one per chunk.`,
  );

  // ...and the frame still completes correctly once the last byte arrives.
  const { frames, error } = dec.push(frame.subarray(frame.length - 1));
  assert.equal(error, null);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].pad, payload);
});

// ---------------------------------------------------------------------------
// T3 — NO ALIASING OF CALLER-OWNED BUFFERS.
// ---------------------------------------------------------------------------
test("T3 aliasing: a reused 1-byte caller scratch buffer still decodes correctly", () => {
  const obj = { id: "sc-1", ok: true, note: "reused scratch" };
  const frame = encodeFrame(obj);

  const dec = new FrameDecoder({ maxFrameBytes: 1024 * 1024 });
  const scratch = Buffer.alloc(1); // ONE buffer, overwritten before every push
  const got = [];
  for (let i = 0; i < frame.length; i++) {
    scratch[0] = frame[i];
    const { frames, error } = dec.push(scratch);
    assert.equal(error, null, `unexpected error at byte ${i}`);
    got.push(...frames);
  }
  assert.deepEqual(got, [obj]);
});

// ---------------------------------------------------------------------------
// T4 — BEHAVIOURAL PARITY. Every check here passes on the unmodified decoder.
// ---------------------------------------------------------------------------
test("T4 parity: splits, multi-frame chunks, caps at the prefix, errors, residue", () => {
  const CAP = 1024 * 1024;

  // (1) Multi-byte UTF-8, split at EVERY byte offset.
  const uni = { s: "héllo 🌍 日本語 — ✓" };
  const uframe = encodeFrame(uni);
  for (let i = 1; i < uframe.length; i++) {
    const d = new FrameDecoder({ maxFrameBytes: CAP });
    const a = d.push(uframe.subarray(0, i));
    assert.equal(a.error, null, `split ${i}: head errored`);
    const b = d.push(uframe.subarray(i));
    assert.equal(b.error, null, `split ${i}: tail errored`);
    assert.deepEqual([...a.frames, ...b.frames], [uni], `split at ${i}`);
  }

  // (2) Three frames in ONE chunk yield three frames from one push.
  const f1 = encodeFrame({ a: 1 });
  const f2 = encodeFrame({ b: "two" });
  const f3 = encodeFrame({ c: [3, 3, 3] });
  const d2 = new FrameDecoder({ maxFrameBytes: CAP });
  const r2 = d2.push(Buffer.concat([f1, f2, f3]));
  assert.equal(r2.error, null);
  assert.deepEqual(r2.frames, [{ a: 1 }, { b: "two" }, { c: [3, 3, 3] }]);

  // (3) Frame 1 + a PARTIAL frame 2 in one chunk: frame 1 lands immediately.
  const d3 = new FrameDecoder({ maxFrameBytes: CAP });
  const split = 6;
  const r3a = d3.push(Buffer.concat([f1, f2.subarray(0, split)]));
  assert.equal(r3a.error, null);
  assert.deepEqual(r3a.frames, [{ a: 1 }]);
  const r3b = d3.push(f2.subarray(split));
  assert.equal(r3b.error, null);
  assert.deepEqual(r3b.frames, [{ b: "two" }]);

  // (4) Over-cap DECLARED length errors from the prefix alone; decoder dead.
  const d4 = new FrameDecoder({ maxFrameBytes: CAP });
  const r4 = d4.push(prefixOf(CAP + 1));
  assert.equal(r4.error.code, ERROR_CODES.BAD_FRAME);
  assert.match(r4.error.message, /exceeds cap/);
  assert.deepEqual(r4.frames, []);
  const r4b = d4.push(Buffer.from("more bytes that must be ignored"));
  assert.equal(r4b.error, r4.error, "dead decoder returns the SAME error object");
  assert.deepEqual(r4b.frames, []);

  // (5) Same cap check fires when the 4-byte prefix arrives split 1/2/1.
  const p5 = prefixOf(CAP + 4096);
  const d5 = new FrameDecoder({ maxFrameBytes: CAP });
  assert.equal(d5.push(p5.subarray(0, 1)).error, null);
  assert.equal(d5.push(p5.subarray(1, 3)).error, null);
  const r5 = d5.push(p5.subarray(3, 4));
  assert.equal(r5.error.code, ERROR_CODES.BAD_FRAME);
  assert.match(r5.error.message, /exceeds cap/);

  // (6) Zero-length declared frame is malformed.
  const d6 = new FrameDecoder({ maxFrameBytes: CAP });
  const r6 = d6.push(prefixOf(0));
  assert.equal(r6.error.code, ERROR_CODES.BAD_FRAME);
  assert.match(r6.error.message, /zero-length frame/);

  // (7) Malformed JSON body is one structured error.
  const badBody = Buffer.from("npmpm", "utf8");
  const d7 = new FrameDecoder({ maxFrameBytes: CAP });
  const r7 = d7.push(Buffer.concat([prefixOf(badBody.length), badBody]));
  assert.equal(r7.error.code, ERROR_CODES.BAD_FRAME);
  assert.match(r7.error.message, /malformed JSON/);

  // (8) A valid frame followed by an over-cap prefix in ONE chunk returns
  //     BOTH the decoded frame and the error. queryd.js:621-631 depends on it.
  const d8 = new FrameDecoder({ maxFrameBytes: CAP });
  const r8 = d8.push(Buffer.concat([f1, prefixOf(CAP + 1)]));
  assert.deepEqual(r8.frames, [{ a: 1 }]);
  assert.equal(r8.error.code, ERROR_CODES.BAD_FRAME);
  assert.match(r8.error.message, /exceeds cap/);

  // (9) push(null) and push(empty) are no-ops.
  const d9 = new FrameDecoder({ maxFrameBytes: CAP });
  assert.deepEqual(d9.push(null), { frames: [], error: null });
  assert.deepEqual(d9.push(Buffer.alloc(0)), { frames: [], error: null });
  assert.deepEqual(d9.push(undefined), { frames: [], error: null });
  // ...and the decoder still works afterwards.
  assert.deepEqual(d9.push(f1).frames, [{ a: 1 }]);

  // (10) Residue, PREFIX path: no frame bytes reachable after an error.
  const secret = Buffer.from("SECRETSECRETSECRET"); // "SECR" declares 1397051730
  const d10 = new FrameDecoder({ maxFrameBytes: CAP });
  const r10 = d10.push(secret);
  assert.equal(r10.error.code, ERROR_CODES.BAD_FRAME);
  assert.match(r10.error.message, /exceeds cap/);
  const hex10 = retainedHex(d10);
  assert.ok(
    !hex10.includes(secret.toString("hex")),
    "frame bytes survived a prefix-path error",
  );
  assert.ok(
    !hex10.includes(secret.subarray(0, 4).toString("hex")),
    "the declared-length prefix bytes survived a prefix-path error",
  );

  // (11) Byte-at-a-time two-frame round-trip (mirrors queryd.test.mjs:232 so
  //      this suite stands alone).
  const d11 = new FrameDecoder({ maxFrameBytes: 1024 });
  const joined = Buffer.concat([f1, f2]);
  const got11 = [];
  for (let i = 0; i < joined.length; i++) {
    const { frames, error } = d11.push(joined.subarray(i, i + 1));
    assert.equal(error, null);
    got11.push(...frames);
  }
  assert.deepEqual(got11, [{ a: 1 }, { b: "two" }]);

  // (12) Residue, BODY path: a malformed-JSON body is the path that actually
  //      populates body storage — it must leave nothing reachable either.
  const canary = Buffer.from('{"k":"CANARYCANARYCANARY"', "utf8"); // truncated JSON
  const d12 = new FrameDecoder({ maxFrameBytes: CAP });
  const r12 = d12.push(Buffer.concat([prefixOf(canary.length), canary]));
  assert.equal(r12.error.code, ERROR_CODES.BAD_FRAME);
  assert.match(r12.error.message, /malformed JSON/);
  const hex12 = retainedHex(d12);
  assert.ok(
    !hex12.includes(Buffer.from("CANARYCANARYCANARY").toString("hex")),
    "frame bytes survived a body-path (malformed JSON) error",
  );
});

// ---------------------------------------------------------------------------
// T6 — DECLARE-AND-STALL BOUND. Rejects naive preallocation of the declared
// length: queryd.js builds one decoder per accepted connection (:621) and
// imposes no connection cap, so a 4-byte declaration must not pin the cap.
// ---------------------------------------------------------------------------
test("T6 declare-and-stall: a 5-byte push must not pin the frame cap", (t) => {
  const dec = new FrameDecoder({ maxFrameBytes: MAX_OUTBOUND_FRAME_BYTES });
  const declared = MAX_OUTBOUND_FRAME_BYTES - 1;
  const chunk = Buffer.concat([prefixOf(declared), Buffer.from([0x7b])]); // '{'
  const { frames, error } = dec.push(chunk);
  assert.equal(error, null);
  assert.deepEqual(frames, []);

  let pinned = 0;
  for (const b of retainedBuffers(dec)) pinned += b.length;
  t.diagnostic(
    `T6: declared ${declared} B, received 1 B -> ${(pinned / (1024 * 1024)).toFixed(2)} MiB pinned`,
  );
  assert.ok(
    pinned <= 1024 * 1024,
    `declare-and-stall pinned ${(pinned / (1024 * 1024)).toFixed(2)} MiB from a 5-byte push ` +
      `(bound 1.00 MiB). Preallocating the declared length pins ` +
      `${(MAX_OUTBOUND_FRAME_BYTES / (1024 * 1024)).toFixed(2)} MiB per connection.`,
  );
});

// ---------------------------------------------------------------------------
// T5 — RECORDED PERF PROBE. Assert loosely, report exactly.
// ---------------------------------------------------------------------------
test("T5 perf probe: a real 256x4096 vector_fetch response frame", (t) => {
  const rnd = makeRng(0x51d1);
  const vectors = new Array(256);
  for (let i = 0; i < 256; i++) {
    const vector = new Array(4096);
    for (let d = 0; d < 4096; d++) vector[d] = rnd();
    vectors[i] = { id: `mem-${i}`, vector };
  }
  const resp = { id: "vf-1", ok: true, generation: 7, state: "ready", vectors };
  const frame = encodeFrame(resp, { maxBytes: MAX_OUTBOUND_FRAME_BYTES });

  const dec = new FrameDecoder({ maxFrameBytes: MAX_OUTBOUND_FRAME_BYTES });
  const t0 = process.hrtime.bigint();
  const got = feedInSlices(dec, frame, 8192);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  t.diagnostic(
    `T5: frame=${frame.length} B (${(frame.length / (1024 * 1024)).toFixed(1)} MiB) ` +
      `in ${Math.ceil(frame.length / 8192)} chunks of 8192 B -> decode ${ms.toFixed(1)} ms`,
  );

  assert.equal(got.length, 1);
  assert.equal(got[0].vectors.length, 256);
  assert.equal(got[0].vectors[255].id, "mem-255");
  assert.equal(got[0].vectors[255].vector.length, 4096);
  assert.equal(got[0].vectors[255].vector[4095], resp.vectors[255].vector[4095]);

  // Loose ceiling only — the recorded number is the finding, not the gate.
  assert.ok(
    ms < 750,
    `vector_fetch frame decode took ${ms.toFixed(1)} ms for ${frame.length} bytes (ceiling 750 ms)`,
  );
});
