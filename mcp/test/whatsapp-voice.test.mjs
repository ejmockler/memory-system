// whatsapp-voice.test.mjs — unit tests for lib/connectors/whatsapp-voice.js.
//
// HERMETIC: mkdtemp dirs only, an injected fake runner (python is NEVER
// spawned), no reads of the real ChatStorage, ledgers or gamepause state.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "whatsapp-voice-test-"));
for (const d of ["policy", "ledgers", "storage/sources", "connectors"]) {
  mkdirSync(join(TEST_ROOT, d), { recursive: true });
}
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
process.env.CONNECTORS_BASE_DIR = join(TEST_ROOT, "connectors");
process.on("exit", () => {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
});

const V = await import("../lib/connectors/whatsapp-voice.js");
const {
  TRANSCRIBE_CONSENT,
  isVoiceCandidate,
  resolveMediaPath,
  isGamePaused,
  transcribeBatch,
  passesQualityGate,
  applyTranscriptInBand,
  buildEnrichmentRow,
  defaultPythonRunner,
  defaultPauseFlag,
} = V;

// Run fn with GAMEPAUSE_FLAG set to `value` (undefined = deleted), restoring
// the previous state afterwards whether or not fn throws.
async function withPauseEnv(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, "GAMEPAUSE_FLAG");
  const prev = process.env.GAMEPAUSE_FLAG;
  if (value === undefined) delete process.env.GAMEPAUSE_FLAG;
  else process.env.GAMEPAUSE_FLAG = value;
  try {
    return await fn();
  } finally {
    if (had) process.env.GAMEPAUSE_FLAG = prev;
    else delete process.env.GAMEPAUSE_FLAG;
  }
}

let n = 0;
function freshDir(prefix) {
  return mkdtempSync(join(TEST_ROOT, `${prefix}-${n++}-`));
}
// Hermetic media root: every batch test passes it as opts.mediaRoot, and audio
// fixtures ("src" dirs) live under it so jobs carry only a RELATIVE
// media_local_path — transcribeBatch derives the absolute path itself.
const MEDIA = mkdtempSync(join(TEST_ROOT, "media-"));
function freshSrc() {
  return mkdtempSync(join(MEDIA, `src-${n++}-`));
}
function audio(dir, name, bytes = "OggS-fake-opus") {
  const p = join(dir, name);
  writeFileSync(p, bytes);
  return p;
}
// Every batch test pins the pause flag to a hermetic, absent path.
const NO_FLAG = join(TEST_ROOT, "no-such-pause-flag");
const RC_1ON1 = Object.freeze({ message_type: 3, media_local_path: "Media/x.opus", is_from_me: 0, session_type: 0, session_jid: "peer@s.whatsapp.net" });
// `file` is an absolute fixture path under MEDIA; the job carries only its
// relative media_local_path (no absPath).
const job = (id, file, durationS, rcOver = {}) => ({
  id, durationS, rawContent: { ...RC_1ON1, media_local_path: relative(MEDIA, file), ...rcOver },
});
const copyNameOf = (id, ext = ".opus") => createHash("sha256").update(String(id)).digest("hex").slice(0, 16) + ext;
const good = (id, extra = {}) => ({
  id, text: ` hello ${id} `, language: "en", avg_logprob: -0.3,
  no_speech_prob: 0.05, compression_ratio: 1.4, duration_s: 4.2, ...extra,
});

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------

test("TRANSCRIBE_CONSENT is frozen 1:1 set", () => {
  assert.deepEqual([...TRANSCRIBE_CONSENT], ["first_party", "second_party_dm"]);
  assert.ok(Object.isFrozen(TRANSCRIBE_CONSENT));
  assert.equal(typeof defaultPythonRunner(), "function");
});

test("isVoiceCandidate: type 3 only, exact numeric", () => {
  const rc = { message_type: 3, media_local_path: "Media/x.opus", session_type: 0, session_jid: "peer@s.whatsapp.net" };
  assert.equal(isVoiceCandidate(rc, "second_party_dm"), true);
  assert.equal(isVoiceCandidate(rc, "first_party"), true);
  assert.equal(isVoiceCandidate({ ...rc, message_type: "3" }, "second_party_dm"), true);
  for (const t of [32, 34, 7, "32", 0, null]) {
    assert.equal(isVoiceCandidate({ ...rc, message_type: t }, "second_party_dm"), false, `type ${t}`);
  }
});

test("isVoiceCandidate: third_party_inferred / unknown consent rejected", () => {
  const rc = { message_type: 3, media_local_path: "Media/x.opus", session_type: 0, session_jid: "peer@s.whatsapp.net" };
  assert.equal(isVoiceCandidate(rc, "third_party_inferred"), false);
  assert.equal(isVoiceCandidate(rc, undefined), false);
  assert.equal(isVoiceCandidate(rc, "third_party_inferred", { allowedConsent: ["third_party_inferred"] }), true);
});

test("isVoiceCandidate: existing text / missing media rejected", () => {
  const rc = { message_type: 3, media_local_path: "Media/x.opus", session_type: 0, session_jid: "peer@s.whatsapp.net" };
  assert.equal(isVoiceCandidate({ ...rc, text: "already" }, "second_party_dm"), false);
  assert.equal(isVoiceCandidate({ ...rc, text: "   " }, "second_party_dm"), true);
  assert.equal(isVoiceCandidate({ ...rc, text: null }, "second_party_dm"), true);
  assert.equal(isVoiceCandidate({ ...rc, media_local_path: "" }, "second_party_dm"), false);
  assert.equal(isVoiceCandidate({ ...rc, media_local_path: null }, "second_party_dm"), false);
  assert.equal(isVoiceCandidate(null, "second_party_dm"), false);
});

test("resolveMediaPath: joins root, rejects traversal/absolute", () => {
  const root = "/fake/root";
  assert.equal(resolveMediaPath("Media/a/b.opus", { mediaRoot: root }), "/fake/root/Media/a/b.opus");
  assert.equal(resolveMediaPath("../x.opus", { mediaRoot: root }), null);
  assert.equal(resolveMediaPath("Media/../../x.opus", { mediaRoot: root }), null);
  assert.equal(resolveMediaPath("Media\\..\\x.opus", { mediaRoot: root }), null);
  assert.equal(resolveMediaPath("/etc/passwd", { mediaRoot: root }), null);
  assert.equal(resolveMediaPath("", { mediaRoot: root }), null);
  assert.equal(resolveMediaPath(null, { mediaRoot: root }), null);
  assert.equal(resolveMediaPath("Media/..x.opus", { mediaRoot: root }), "/fake/root/Media/..x.opus");
});

test("isGamePaused: flag present / absent", () => {
  const dir = freshDir("pause");
  const flag = join(dir, "paused");
  assert.equal(isGamePaused({ flagPath: flag }), false);
  writeFileSync(flag, "");
  assert.equal(isGamePaused({ flagPath: flag }), true);
});

test("pause flag default: GAMEPAUSE_FLAG unset or empty -> no default path, never paused", async () => {
  await withPauseEnv(undefined, () => {
    assert.equal(defaultPauseFlag(), null);
    assert.equal(isGamePaused(), false);
    assert.equal(isGamePaused({}), false);
    assert.equal(isGamePaused({ flagPath: undefined }), false);
  });
  await withPauseEnv("", () => {
    assert.equal(defaultPauseFlag(), null);
    assert.equal(isGamePaused(), false);
  });
});

test("pause flag default: GAMEPAUSE_FLAG from the environment is honoured; an explicit flagPath wins", async () => {
  const dir = freshDir("pause-env");
  const envFlag = join(dir, "env-paused");
  const optFlag = join(dir, "opt-paused");
  await withPauseEnv(envFlag, () => {
    assert.equal(defaultPauseFlag(), envFlag);
    assert.equal(isGamePaused(), false);
    writeFileSync(envFlag, "");
    assert.equal(isGamePaused(), true);
    // The explicit option (absent file) beats the environment (present file).
    assert.equal(isGamePaused({ flagPath: optFlag }), false);
  });
  // And the reverse: explicit option present, environment unset.
  writeFileSync(optFlag, "");
  await withPauseEnv(undefined, () => {
    assert.equal(isGamePaused({ flagPath: optFlag }), true);
  });
});

// ---------------------------------------------------------------------------
// transcribeBatch
// ---------------------------------------------------------------------------

test("transcribeBatch: success path, tmp perms, timeout formula, cleanup", async () => {
  const src = freshSrc();
  const tmp = join(freshDir("tmp"), "voice");
  const jobs = [
    job("a", audio(src, "a.opus"), 10),
    job("b", audio(src, "b.opus"), 20),
  ];
  let seen = null;
  const runner = async (input, { timeoutMs }) => {
    seen = { input, timeoutMs };
    for (const j of input) {
      assert.ok(j.path.startsWith(tmp));
      assert.equal(statSync(j.path).mode & 0o777, 0o600);
      assert.match(j.path, /[0-9a-f]{16}\.opus$/);
    }
    assert.equal(statSync(tmp).mode & 0o777, 0o700);
    return [good("b"), good("a")];
  };
  const out = await transcribeBatch(jobs, { runner, tmpDir: tmp, flagPath: NO_FLAG, mediaRoot: MEDIA });
  assert.equal(seen.timeoutMs, 60000 + 150 * 30);
  assert.deepEqual(seen.input.map((j) => j.id), ["a", "b"]);
  assert.deepEqual(Object.keys(seen.input[0]).sort(), ["id", "path"]);
  assert.deepEqual(out.map((o) => o.id), ["a", "b"]);
  assert.ok(out.every((o) => o.ok === true));
  assert.equal(out[0].text, "hello a");
  assert.equal(out[0].stt.engine, "mlx-whisper");
  assert.equal(out[0].stt.language, "en");
  assert.equal(readdirSync(tmp).length, 0);
});

test("transcribeBatch: runner throws -> stt_error, tmp empty", async () => {
  const src = freshSrc();
  const tmp = join(freshDir("tmp"), "voice");
  const jobs = [
    job("a", audio(src, "a.opus"), 5),
    job("b", audio(src, "b.opus"), 5),
  ];
  const out = await transcribeBatch(jobs, {
    runner: async () => { throw new Error("boom"); }, tmpDir: tmp, flagPath: NO_FLAG, mediaRoot: MEDIA,
  });
  assert.deepEqual(out.map((o) => o.reason), ["stt_error", "stt_error"]);
  assert.ok(out.every((o) => o.ok === false));
  assert.equal(readdirSync(tmp).length, 0);
});

test("transcribeBatch: too_long and batch_cap, runner sees only admitted", async () => {
  const src = freshSrc();
  const tmp = join(freshDir("tmp"), "voice");
  const jobs = [
    job("long", audio(src, "l.opus"), 901),
    job("a", audio(src, "a.opus"), 900),
    job("b", audio(src, "b.opus"), 850),
    job("c", audio(src, "c.opus"), 100),
    job("d", audio(src, "d.opus"), 50),
  ];
  let ids = null;
  let timeout = null;
  const out = await transcribeBatch(jobs, {
    runner: async (input, { timeoutMs }) => { ids = input.map((j) => j.id); timeout = timeoutMs; return input.map((j) => good(j.id)); },
    tmpDir: tmp, flagPath: NO_FLAG, mediaRoot: MEDIA,
  });
  assert.deepEqual(ids, ["a", "b", "d"]);
  assert.equal(timeout, 60000 + 150 * 1800);
  assert.deepEqual(out.map((o) => [o.id, o.ok, o.reason]), [
    ["long", false, "too_long"],
    ["a", true, null],
    ["b", true, null],
    ["c", false, "batch_cap"],
    ["d", true, null],
  ]);
  assert.equal(readdirSync(tmp).length, 0);
});

test("transcribeBatch: unreadable, no_result, stt_error, quality_gate mapping", async () => {
  const src = freshSrc();
  const tmp = join(freshDir("tmp"), "voice");
  const jobs = [
    job("gone", join(src, "missing.opus"), 3),
    job("nores", audio(src, "n.opus"), 3),
    job("err", audio(src, "e.opus"), 3),
    job("bad", audio(src, "q.opus"), 3),
    job("ok", audio(src, "o.opus"), 3),
  ];
  let ids = null;
  const out = await transcribeBatch(jobs, {
    runner: async (input) => {
      ids = input.map((j) => j.id);
      return [{ id: "err", error: "RuntimeError" }, good("bad", { compression_ratio: 3 }), good("ok"), { id: "stranger", text: "x" }];
    },
    tmpDir: tmp, flagPath: NO_FLAG, mediaRoot: MEDIA,
  });
  assert.deepEqual(ids, ["nores", "err", "bad", "ok"]);
  assert.deepEqual(out.map((o) => o.reason), ["unreadable", "no_result", "stt_error", "quality_gate", null]);
  assert.equal(out.length, jobs.length);
  assert.equal(readdirSync(tmp).length, 0);
});

test("transcribeBatch: nothing admitted -> runner not called", async () => {
  const tmp = join(freshDir("tmp"), "voice");
  let called = false;
  const out = await transcribeBatch([job("x", join(MEDIA, "nope.opus"), 5000)], {
    runner: async () => { called = true; return []; }, tmpDir: tmp, flagPath: NO_FLAG, mediaRoot: MEDIA,
  });
  assert.equal(called, false);
  assert.equal(out[0].reason, "too_long");
  assert.equal(existsSync(tmp), false);
});

test("transcribeBatch: paused -> every job 'paused', runner never called, tmpDir empty", async () => {
  const src = freshSrc();
  const tmp = join(freshDir("tmp"), "voice");
  const flag = join(freshDir("pause"), "paused");
  writeFileSync(flag, "");
  let calls = 0;
  const out = await transcribeBatch(
    [job("a", audio(src, "a.opus"), 5), job("b", audio(src, "b.opus"), 5), job("a", audio(src, "c.opus"), 5)],
    { runner: async () => { calls++; return []; }, tmpDir: tmp, flagPath: flag, mediaRoot: MEDIA },
  );
  assert.equal(calls, 0);
  assert.deepEqual(out.map((o) => o.reason), ["paused", "paused", "paused"]);
  assert.ok(out.every((o) => o.ok === false));
  assert.ok(!existsSync(tmp) || readdirSync(tmp).length === 0);
});

test("invariant 1: group / broadcast / third_party job -> not_eligible, never copied", async () => {
  const src = freshSrc();
  const tmp = join(freshDir("tmp"), "voice");
  const jobs = [
    job("grp", audio(src, "g.opus"), 5, { is_from_me: 0, session_type: 1 }),
    job("mine-in-grp", audio(src, "m.opus"), 5, { is_from_me: 1, session_type: 1 }),
    job("bcast", audio(src, "bc.opus"), 5, { is_from_me: 1, session_type: 2 }),
    job("gus", audio(src, "gu.opus"), 5, { is_from_me: 1, session_type: 0, session_jid: "1-2@g.us" }),
    job("liar", audio(src, "l.opus"), 5, { is_from_me: 0, session_type: 1 }),
    { id: "bare", absPath: audio(src, "bare.opus"), durationS: 5 },
    job("ok", audio(src, "o.opus"), 5),
  ];
  jobs[4].consentBasis = "second_party_dm"; // caller claims 1:1; classifyRow disagrees
  const banned = jobs.slice(0, 6).map((j) => copyNameOf(j.id));
  let seenDir = null;
  let calls = 0;
  const out = await transcribeBatch(jobs, {
    runner: async (input) => {
      calls++;
      seenDir = readdirSync(tmp);
      return input.map((j) => good(j.id));
    },
    tmpDir: tmp, flagPath: NO_FLAG, mediaRoot: MEDIA,
  });
  assert.equal(calls, 1);
  assert.deepEqual(seenDir, [copyNameOf("ok")]);
  for (const b of banned) assert.ok(!seenDir.includes(b));
  assert.deepEqual(out.map((o) => o.reason), [
    "not_eligible", "not_eligible", "not_eligible", "not_eligible",
    "not_eligible", "not_eligible", null,
  ]);
  assert.equal(readdirSync(tmp).length, 0);

  // group-only batch: runner never called, tmp dir never even created
  const tmp2 = join(freshDir("tmp"), "voice");
  let called = false;
  const out2 = await transcribeBatch([job("g", audio(src, "g2.opus"), 5, { session_type: 1 })], {
    runner: async () => { called = true; return []; }, tmpDir: tmp2, flagPath: NO_FLAG, mediaRoot: MEDIA,
  });
  assert.equal(called, false);
  assert.equal(out2[0].reason, "not_eligible");
  assert.equal(existsSync(tmp2), false);
});

test("transcribeBatch: legacy sessionType form / absPath-only job -> not_eligible, uncopied", async () => {
  const src = freshSrc();
  const tmp = join(freshDir("tmp"), "voice");
  let called = false;
  const out = await transcribeBatch(
    [
      { id: "s", absPath: audio(src, "s.opus"), durationS: 3, sessionType: 0, sessionJid: "p@s.whatsapp.net", consentBasis: "second_party_dm" },
      { id: "p", absPath: audio(src, "p.opus"), durationS: 3 },
    ],
    { runner: async (input) => { called = true; return input.map((j) => good(j.id)); }, tmpDir: tmp, flagPath: NO_FLAG, mediaRoot: MEDIA },
  );
  assert.equal(called, false);
  assert.deepEqual(out.map((o) => o.reason), ["not_eligible", "not_eligible"]);
  assert.ok(!existsSync(tmp) || readdirSync(tmp).length === 0);
});

test("transcribeBatch: caller consentBasis disagreeing with classifyRow -> not_eligible, tmpDir empty", async () => {
  const src = freshSrc();
  const tmp = join(freshDir("tmp"), "voice");
  // inbound 1:1 classifies second_party_dm; caller claims first_party
  const lie = { ...job("lie", audio(src, "lie.opus"), 3), consentBasis: "first_party" };
  const agree = { ...job("agree", audio(src, "agree.opus"), 3), consentBasis: "second_party_dm" };
  let seenDir = null;
  const out = await transcribeBatch([lie, agree], {
    runner: async (input) => { seenDir = readdirSync(tmp); return input.map((j) => good(j.id)); },
    tmpDir: tmp, flagPath: NO_FLAG, mediaRoot: MEDIA,
  });
  assert.deepEqual(out.map((o) => o.reason), ["not_eligible", null]);
  assert.deepEqual(seenDir, [copyNameOf("agree")]);
  assert.deepEqual(readdirSync(tmp), []);

  // mismatch alone: runner never called, tmpDir never created
  const tmp2 = join(freshDir("tmp"), "voice");
  let called = false;
  const out2 = await transcribeBatch([{ ...job("l2", audio(src, "l2.opus"), 3), consentBasis: "third_party_inferred" }], {
    runner: async () => { called = true; return []; }, tmpDir: tmp2, flagPath: NO_FLAG, mediaRoot: MEDIA,
  });
  assert.equal(called, false);
  assert.equal(out2[0].reason, "not_eligible");
  assert.ok(!existsSync(tmp2) || readdirSync(tmp2).length === 0);
});

test("transcribeBatch: traversal / absolute media_local_path never copied", async () => {
  const src = freshSrc();
  const tmp = join(freshDir("tmp"), "voice");
  const outside = audio(freshDir("outside"), "secret.opus", "SECRET");
  const jobs = [
    { id: "dotdot", durationS: 3, rawContent: { ...RC_1ON1, media_local_path: relative(MEDIA, outside) } },
    { id: "dotdot2", durationS: 3, rawContent: { ...RC_1ON1, media_local_path: "Media/../../x.opus" } },
    { id: "abs", durationS: 3, rawContent: { ...RC_1ON1, media_local_path: outside } },
    job("ok", audio(src, "ok.opus"), 3),
  ];
  assert.ok(jobs[0].rawContent.media_local_path.includes(".."));
  assert.ok(jobs[2].rawContent.media_local_path.startsWith("/"));
  let seenDir = null;
  const out = await transcribeBatch(jobs, {
    runner: async (input) => { seenDir = readdirSync(tmp); return input.map((j) => good(j.id)); },
    tmpDir: tmp, flagPath: NO_FLAG, mediaRoot: MEDIA,
  });
  assert.deepEqual(seenDir, [copyNameOf("ok")]);
  assert.equal(out[3].ok, true);
  for (const o of out.slice(0, 3)) {
    assert.equal(o.ok, false);
    assert.ok(o.reason === "not_eligible" || o.reason === "unreadable", o.reason);
  }
  assert.deepEqual(readdirSync(tmp), []);
});

test("transcribeBatch: caller absPath ignored; bytes come from mediaRoot/media_local_path", async () => {
  const src = freshSrc();
  const tmp = join(freshDir("tmp"), "voice");
  const real = audio(src, "real.opus", "REAL-BYTES");
  const decoy = audio(freshDir("decoy"), "decoy.opus", "DECOY-BYTES");
  const j = { ...job("a", real, 3), absPath: decoy };
  let copied = null;
  const out = await transcribeBatch([j], {
    runner: async (input) => { copied = readFileSync(input[0].path, "utf8"); return input.map((x) => good(x.id)); },
    tmpDir: tmp, flagPath: NO_FLAG, mediaRoot: MEDIA,
  });
  assert.equal(copied, "REAL-BYTES");
  assert.equal(out[0].ok, true);

  // absPath pointing at a real file but media_local_path missing under root -> unreadable, decoy never copied
  const tmp2 = join(freshDir("tmp"), "voice");
  let called = false;
  const out2 = await transcribeBatch([{ ...job("b", join(src, "absent.opus"), 3), absPath: decoy }], {
    runner: async () => { called = true; return []; }, tmpDir: tmp2, flagPath: NO_FLAG, mediaRoot: MEDIA,
  });
  assert.equal(called, false);
  assert.equal(out2[0].reason, "unreadable");
  assert.deepEqual(readdirSync(tmp2), []);
});

test("transcribeBatch: duplicate ids -> first wins, later 'duplicate'", async () => {
  const src = freshSrc();
  const tmp = join(freshDir("tmp"), "voice");
  let ids = null;
  const out = await transcribeBatch(
    [job("a", audio(src, "a1.opus"), 3), job("b", audio(src, "b.opus"), 3), job("a", audio(src, "a2.opus"), 3), job("a", audio(src, "a3.opus"), 3)],
    { runner: async (input) => { ids = input.map((j) => j.id); return input.map((j) => good(j.id)); }, tmpDir: tmp, flagPath: NO_FLAG, mediaRoot: MEDIA },
  );
  assert.deepEqual(ids, ["a", "b"]);
  assert.deepEqual(out.map((o) => [o.id, o.ok, o.reason]), [
    ["a", true, null], ["b", true, null], ["a", false, "duplicate"], ["a", false, "duplicate"],
  ]);
});

test("transcribeBatch: missing/0 duration estimated from size drives too_long, batch_cap, timeout", async () => {
  const src = freshSrc();
  const tmp = join(freshDir("tmp"), "voice");
  const big = audio(src, "big.opus", Buffer.alloc(2_000_000)); // ~1000s
  const mid = audio(src, "mid.opus", Buffer.alloc(1_700_000)); // ~850s
  const mid2 = audio(src, "mid2.opus", Buffer.alloc(1_000_000)); // ~500s -> over cap
  const tiny = audio(src, "tiny.opus", Buffer.alloc(10)); // floor 1s
  let timeout = null;
  let ids = null;
  const out = await transcribeBatch(
    [job("big", big, undefined), job("mid", mid, 0), job("x", audio(src, "x.opus"), 900), job("mid2", mid2, null), job("tiny", tiny)],
    { runner: async (input, { timeoutMs }) => { ids = input.map((j) => j.id); timeout = timeoutMs; return input.map((j) => good(j.id)); }, tmpDir: tmp, flagPath: NO_FLAG, mediaRoot: MEDIA },
  );
  assert.deepEqual(out.map((o) => o.reason), ["too_long", null, null, "batch_cap", null]);
  assert.deepEqual(ids, ["mid", "x", "tiny"]);
  assert.equal(timeout, 60000 + 150 * (850 + 900 + 1));
});

test("transcribeBatch: runner receives timeoutMs === 60000 + 150*sum(audio_s)", async () => {
  const src = freshSrc();
  const tmp = join(freshDir("tmp"), "voice");
  let timeout = null;
  await transcribeBatch(
    [job("a", audio(src, "a.opus"), 12.5), job("b", audio(src, "b.opus"), 7.5), job("c", audio(src, "c.opus", Buffer.alloc(40_000)))],
    { runner: async (input, { timeoutMs }) => { timeout = timeoutMs; return []; }, tmpDir: tmp, flagPath: NO_FLAG, mediaRoot: MEDIA },
  );
  assert.equal(timeout, 60000 + 150 * (12.5 + 7.5 + 20));
});

test("invariant 6: stale (>1h) tmp file swept before copy, fresh kept", async () => {
  const src = freshSrc();
  const tmp = join(freshDir("tmp"), "voice");
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const stale = join(tmp, "deadbeefdeadbeef.opus");
  const fresh = join(tmp, "cafebabecafebabe.opus");
  writeFileSync(stale, "old");
  writeFileSync(fresh, "new");
  const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  utimesSync(stale, old, old);
  let atRunner = null;
  await transcribeBatch([job("a", audio(src, "a.opus"), 3)], {
    runner: async (input) => { atRunner = readdirSync(tmp).sort(); return input.map((j) => good(j.id)); },
    tmpDir: tmp, flagPath: NO_FLAG, mediaRoot: MEDIA,
  });
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true);
  assert.deepEqual(atRunner, [copyNameOf("a"), "cafebabecafebabe.opus"].sort());
  assert.deepEqual(readdirSync(tmp), ["cafebabecafebabe.opus"]);
});

test("invariant 6: tmpDir empty after runner timeout (rejection) and throw", async () => {
  const src = freshSrc();
  for (const fail of [
    async (input, { timeoutMs }) => {
      for (const j of input) assert.ok(existsSync(j.path)); // copies exist mid-run
      await new Promise((r) => setTimeout(r, 5));
      const e = new Error(`timed out after ${timeoutMs}ms`); e.code = "ETIMEDOUT"; throw e;
    },
    () => { throw new Error("sync boom"); },
  ]) {
    const tmp = join(freshDir("tmp"), "voice");
    const out = await transcribeBatch([job("a", audio(src, "a.opus"), 3), job("b", audio(src, "b.opus"), 3)], {
      runner: fail, tmpDir: tmp, flagPath: NO_FLAG, mediaRoot: MEDIA,
    });
    assert.deepEqual(out.map((o) => o.reason), ["stt_error", "stt_error"]);
    assert.deepEqual(readdirSync(tmp), []);
  }
});

// ---------------------------------------------------------------------------
// quality gate
// ---------------------------------------------------------------------------

test("passesQualityGate: every branch", () => {
  assert.equal(passesQualityGate(good("x")), true);
  assert.equal(passesQualityGate(good("x", { text: "" })), false);
  assert.equal(passesQualityGate(good("x", { text: "   " })), false);
  assert.equal(passesQualityGate(good("x", { text: null })), false);
  assert.equal(passesQualityGate(good("x", { compression_ratio: 2.41 })), false);
  assert.equal(passesQualityGate(good("x", { compression_ratio: 2.4 })), true);
  assert.equal(passesQualityGate(good("x", { no_speech_prob: 0.7, avg_logprob: -1.5 })), false);
  assert.equal(passesQualityGate(good("x", { no_speech_prob: 0.7, avg_logprob: -0.5 })), true);
  assert.equal(passesQualityGate(good("x", { no_speech_prob: 0.5, avg_logprob: -1.5 })), true);
});

// ---------------------------------------------------------------------------
// row shaping
// ---------------------------------------------------------------------------

function parentRow(over = {}) {
  return {
    ts: "2026-09-27T10:00:00.000Z",
    source_msg_id: "STANZA123",
    kind: "message",
    parties: ["user", "peer@s.whatsapp.net"],
    raw_content: {
      text: null, message_type: 3, media_local_path: "Media/x.opus",
      is_from_me: 0, session_type: 0, session_jid: "peer@s.whatsapp.net", nested: { a: 1 }, ...over,
    },
    attachments: [{ kind: "audio" }],
  };
}
const result = { text: "hi there", stt: { model: "m", language: "en", avg_logprob: -0.2, no_speech_prob: 0.1, compression_ratio: 1.3, duration_s: 3, speech_s: 2.5 } };

test("applyTranscriptInBand: new row, input untouched, fields", () => {
  const row = parentRow();
  const before = structuredClone(row);
  const out = applyTranscriptInBand(row, result);
  assert.deepEqual(row, before);
  assert.notEqual(out, row);
  assert.notEqual(out.raw_content, row.raw_content);
  assert.equal(out.raw_content.text, "hi there");
  assert.equal(out.raw_content.text_origin, "stt");
  assert.deepEqual(out.raw_content.stt, {
    engine: "mlx-whisper", model: "m", language: "en", avg_logprob: -0.2,
    no_speech_prob: 0.1, compression_ratio: 1.3, duration_s: 3, speech_s: 2.5,
  });
  out.raw_content.nested.a = 99;
  assert.equal(row.raw_content.nested.a, 1);
  assert.equal(out.source_msg_id, row.source_msg_id);
});

test("buildEnrichmentRow: shape for second_party_dm", () => {
  const p = parentRow();
  const before = structuredClone(p);
  const e = buildEnrichmentRow(p, result, { consentBasis: "second_party_dm" });
  assert.deepEqual(p, before);
  assert.equal(e.ts, p.ts);
  assert.equal(e.source_msg_id, "STANZA123#stt");
  assert.ok(e.source_msg_id.endsWith("#stt"));
  assert.equal(e.kind, "voice_transcript");
  assert.deepEqual(e.derived_from, ["STANZA123"]);
  assert.deepEqual(e.parties, p.parties);
  assert.notEqual(e.parties, p.parties);
  assert.deepEqual(e.attachments, []);
  assert.equal(e.raw_content.text, "hi there");
  assert.equal(e.raw_content.text_origin, "stt");
  assert.equal(e.raw_content.stt.engine, "mlx-whisper");
  assert.equal(e.raw_content.media_local_path, "Media/x.opus");
});

test("operator's own note: accepted in 1:1, REJECTED in group (1) and broadcast (2)", () => {
  // outbound 1:1 still accepted everywhere
  const dm = parentRow({ is_from_me: 1, session_type: 0 });
  assert.equal(isVoiceCandidate(dm.raw_content, "first_party"), true);
  assert.equal(buildEnrichmentRow(dm, result, { consentBasis: "first_party" }).kind, "voice_transcript");
  assert.equal(applyTranscriptInBand(dm, result).raw_content.text, "hi there");
  for (const st of [1, 2]) {
    const p = parentRow({ is_from_me: 1, session_type: st });
    assert.equal(isVoiceCandidate(p.raw_content, "first_party"), false, `session_type ${st}`);
    assert.throws(() => buildEnrichmentRow(p, result, { consentBasis: "first_party" }), /non-1:1/);
    assert.throws(() => applyTranscriptInBand(p, result), /non-1:1/);
  }
  // acceptance literal row
  const lit = { message_type: 3, media_local_path: "x.opus", is_from_me: 1, session_type: 1 };
  assert.equal(isVoiceCandidate(lit, "first_party"), false);
  assert.throws(() => buildEnrichmentRow({ ts: "t", source_msg_id: "S", parties: [], raw_content: lit }, result, { consentBasis: "first_party" }));
  assert.throws(() => applyTranscriptInBand({ raw_content: lit }, result));
});

test("isOneOnOneSession: session_type fails closed (null/''/false/[]/undefined/'0x0'), '0' accepted", () => {
  const rc = { message_type: 3, media_local_path: "Media/x.opus", is_from_me: 0, session_type: 0, session_jid: "peer@s.whatsapp.net" };
  for (const st of [null, "", false, [], undefined, "0x0", " 0", "0.0", 0.5, NaN, {}, true]) {
    const bad = { ...rc, session_type: st };
    assert.equal(isVoiceCandidate(bad, "second_party_dm"), false, `session_type ${JSON.stringify(st)}`);
    assert.throws(() => applyTranscriptInBand(parentRow({ session_type: st }), result), /non-1:1/);
  }
  const noSt = { ...rc };
  delete noSt.session_type;
  assert.equal(isVoiceCandidate(noSt, "second_party_dm"), false);
  for (const st of [0, "0"]) {
    assert.equal(isVoiceCandidate({ ...rc, session_type: st }, "second_party_dm"), true, `session_type ${JSON.stringify(st)}`);
    assert.equal(isVoiceCandidate({ ...rc, session_type: st, session_jid: "abc@lid" }, "second_party_dm"), true);
  }
});

test("isOneOnOneSession: session_jid allowlist (@lid / @s.whatsapp.net only)", () => {
  const rc = { message_type: 3, media_local_path: "Media/x.opus", is_from_me: 0, session_type: 0 };
  for (const jid of ["", undefined, null, 0, "1-2@g.us", "list@broadcast", "status@broadcast", "status", "peer@example.com", "peer@s.whatsapp.net.evil", "peer@lidx"]) {
    const bad = jid === undefined ? { ...rc } : { ...rc, session_jid: jid };
    assert.equal(isVoiceCandidate(bad, "second_party_dm"), false, `jid ${JSON.stringify(jid)}`);
  }
  for (const jid of ["123456@lid", "peer@s.whatsapp.net", "@lid", "@s.whatsapp.net"]) {
    for (const st of [0, "0"]) {
      assert.equal(isVoiceCandidate({ ...rc, session_type: st, session_jid: jid }, "second_party_dm"), true, `${jid} ${st}`);
    }
  }
});

test("session_jid @g.us / @broadcast / status rejected even when session_type=0", () => {
  for (const jid of ["123-456@g.us", "list@broadcast", "status@broadcast", "status", "", "x@unknown"]) {
    const p = parentRow({ is_from_me: 1, session_type: 0, session_jid: jid });
    assert.equal(isVoiceCandidate(p.raw_content, "first_party"), false, jid);
    assert.throws(() => buildEnrichmentRow(p, result, { consentBasis: "first_party" }), /non-1:1/);
    assert.throws(() => applyTranscriptInBand(p, result), /non-1:1/);
  }
  assert.equal(isVoiceCandidate(parentRow({ session_jid: "peer@s.whatsapp.net" }).raw_content, "second_party_dm"), true);
});

test("buildEnrichmentRow: refuses third_party_inferred and mismatched consent", () => {
  const group = parentRow({ session_type: 1 });
  assert.throws(() => buildEnrichmentRow(group, result, { consentBasis: "third_party_inferred" }));
  // caller lies: claims 1:1 for a group row -> classifyRow disagrees
  assert.throws(() => buildEnrichmentRow(group, result, { consentBasis: "second_party_dm" }));
  assert.throws(() => buildEnrichmentRow(parentRow(), result, {}));
});

// ---------------------------------------------------------------------------
// V6: silence / hallucination gate branches (fake runner results only)
// ---------------------------------------------------------------------------

test("passesQualityGate V6: low speech_s rejects any text", () => {
  assert.equal(passesQualityGate(good("x", { speech_s: 0.2 })), false);
  assert.equal(passesQualityGate(good("x", { speech_s: 0 })), false);
  assert.equal(passesQualityGate(good("x", { speech_s: 0.5 })), true);
  // speech_s absent (older worker) -> the V6 speech checks are skipped.
  assert.equal(passesQualityGate(good("x")), true);
});

test("passesQualityGate V6: every denylist hit under 3 s rejects; same text passes at >= 3 s", () => {
  const hits = [
    "Thank you.", "Thanks for watching!", "Thank you for watching.", "you", "Bye!",
    "E aí", "Eai?", "Subtitles by the Amara.org community", "…",
  ];
  for (const text of hits) {
    assert.equal(passesQualityGate(good("x", { text, speech_s: 2.9 })), false, text);
    if (text !== "…") {
      assert.equal(passesQualityGate(good("x", { text, speech_s: 3 })), true, `${text} @3s`);
      assert.equal(passesQualityGate(good("x", { text, speech_s: 12 })), true, `${text} @12s`);
    }
  }
  // Not on the denylist: a short real phrase passes under 3 s.
  assert.equal(passesQualityGate(good("x", { text: "Thank you, see you at five.", speech_s: 2 })), true);
});

test("passesQualityGate V6: one token repeated >= 3 times and >= 80% of words rejects", () => {
  assert.equal(passesQualityGate(good("x", { text: "aí aí aí", speech_s: 20 })), false);
  assert.equal(passesQualityGate(good("x", { text: "Okay, okay, okay, okay, sure.", speech_s: 20 })), false);
  // 3 of 4 words = 75% < 80% -> passes; 2 repeats -> passes.
  assert.equal(passesQualityGate(good("x", { text: "no no no way", speech_s: 20 })), true);
  assert.equal(passesQualityGate(good("x", { text: "bye bye", speech_s: 20 })), true);
});

test("passesQualityGate V6: a normal transcript passes", () => {
  assert.equal(passesQualityGate(good("x", { text: "Hey, I'll be there around eight tonight.", speech_s: 4.1 })), true);
});

test("transcribeBatch V6: env_error / worker_crash runner lines keep their own reason", async () => {
  const src = freshSrc();
  const tmp = join(freshDir("tmp"), "voice");
  for (const code of ["env_error", "worker_crash"]) {
    const out = await transcribeBatch([job("a", audio(src, `a-${code}.opus`), 3), job("b", audio(src, `b-${code}.opus`), 3)], {
      runner: async (input) => input.map((j) => ({ id: j.id, error: code })),
      tmpDir: tmp, flagPath: NO_FLAG, mediaRoot: MEDIA,
    });
    assert.deepEqual(out.map((o) => [o.ok, o.reason]), [[false, code], [false, code]]);
  }
  assert.equal(readdirSync(tmp).length, 0);
});

// defaultPythonRunner against a node stand-in for python (no real python).
function fakeWorker(body) {
  const dir = freshDir("worker");
  const p = join(dir, "w.mjs");
  writeFileSync(p, `
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { buf += c; });
process.stdin.on("end", () => { const jobs = JSON.parse(buf || "[]"); ${body} });
`);
  return p;
}

test("defaultPythonRunner V6: env passes Homebrew PATH, HF_HUB_OFFLINE and the connector's flag", async () => {
  const flag = join(TEST_ROOT, "custom-flag");
  const script = fakeWorker(`for (const j of jobs) process.stdout.write(JSON.stringify({ id: j.id,
    path_env: process.env.PATH, hf: process.env.HF_HUB_OFFLINE, flag: process.env.GAMEPAUSE_FLAG }) + "\\n");`);
  const out = await defaultPythonRunner({ venvPython: process.execPath, scriptPath: script, flagPath: flag })(
    [{ id: "a", path: "/nonexistent" }], { timeoutMs: 30000 });
  assert.equal(out.length, 1);
  assert.ok(out[0].path_env.startsWith("/opt/homebrew/bin:/usr/local/bin:"), out[0].path_env);
  assert.equal(out[0].hf, "1");
  assert.equal(out[0].flag, flag);
});

// The fake worker reports its own GAMEPAUSE_FLAG: null when the key is absent
// from its environment, else the value.
function flagEchoWorker() {
  return fakeWorker(`for (const j of jobs) process.stdout.write(JSON.stringify({ id: j.id,
    has: Object.prototype.hasOwnProperty.call(process.env, "GAMEPAUSE_FLAG"),
    flag: process.env.GAMEPAUSE_FLAG ?? null }) + "\\n");`);
}

test("defaultPythonRunner: no flagPath and GAMEPAUSE_FLAG unset -> the worker gets no GAMEPAUSE_FLAG", async () => {
  const script = flagEchoWorker();
  const out = await withPauseEnv(undefined, () => defaultPythonRunner({ venvPython: process.execPath, scriptPath: script })(
    [{ id: "a", path: "/nonexistent" }], { timeoutMs: 30000 }));
  assert.equal(out.length, 1);
  assert.equal(out[0].has, false);
  assert.equal(out[0].flag, null);
  // An empty ambient value is dropped rather than forwarded.
  const out2 = await withPauseEnv("", () => defaultPythonRunner({ venvPython: process.execPath, scriptPath: script })(
    [{ id: "a", path: "/nonexistent" }], { timeoutMs: 30000 }));
  assert.equal(out2[0].has, false);
  assert.equal(out2[0].flag, null);
});

test("defaultPythonRunner: GAMEPAUSE_FLAG set in the environment reaches the worker", async () => {
  const script = flagEchoWorker();
  const envFlag = join(TEST_ROOT, "env-flag");
  const out = await withPauseEnv(envFlag, () => defaultPythonRunner({ venvPython: process.execPath, scriptPath: script })(
    [{ id: "a", path: "/nonexistent" }], { timeoutMs: 30000 }));
  assert.equal(out.length, 1);
  assert.equal(out[0].has, true);
  assert.equal(out[0].flag, envFlag);
});

test("defaultPythonRunner: an explicit flagPath beats GAMEPAUSE_FLAG from the environment", async () => {
  const script = flagEchoWorker();
  const envFlag = join(TEST_ROOT, "env-flag");
  const optFlag = join(TEST_ROOT, "option-flag");
  const out = await withPauseEnv(envFlag, () => defaultPythonRunner({ venvPython: process.execPath, scriptPath: script, flagPath: optFlag })(
    [{ id: "a", path: "/nonexistent" }], { timeoutMs: 30000 }));
  assert.equal(out.length, 1);
  assert.equal(out[0].flag, optFlag);
});

test("defaultPythonRunner V6: an env_error line maps EVERY job to {id, error:'env_error'}", async () => {
  const script = fakeWorker(`process.stdout.write(JSON.stringify({ env_error: "ffmpeg_missing" }) + "\\n"); process.exitCode = 4;`);
  const out = await defaultPythonRunner({ venvPython: process.execPath, scriptPath: script, flagPath: NO_FLAG })(
    [{ id: "a", path: "/x" }, { id: "b", path: "/y" }], { timeoutMs: 30000 });
  assert.deepEqual(out, [{ id: "a", error: "env_error" }, { id: "b", error: "env_error" }]);
});

test("defaultPythonRunner V6: non-zero exit with zero job lines is worker_crash; with lines it is not", async () => {
  const crash = fakeWorker(`process.stdout.write("Traceback? not json\\n"); process.exitCode = 1;`);
  const out = await defaultPythonRunner({ venvPython: process.execPath, scriptPath: crash, flagPath: NO_FLAG })(
    [{ id: "a", path: "/x" }, { id: "b", path: "/y" }], { timeoutMs: 30000 });
  assert.deepEqual(out, [{ id: "a", error: "worker_crash" }, { id: "b", error: "worker_crash" }]);

  const partial = fakeWorker(`process.stdout.write(JSON.stringify({ id: jobs[0].id, text: "hi" }) + "\\n"); process.exitCode = 1;`);
  const out2 = await defaultPythonRunner({ venvPython: process.execPath, scriptPath: partial, flagPath: NO_FLAG })(
    [{ id: "a", path: "/x" }, { id: "b", path: "/y" }], { timeoutMs: 30000 });
  assert.deepEqual(out2, [{ id: "a", text: "hi" }]);

  // A clean exit with no lines (e.g. paused) stays an empty array -> no_result.
  const quiet = fakeWorker(``);
  const out3 = await defaultPythonRunner({ venvPython: process.execPath, scriptPath: quiet, flagPath: NO_FLAG })(
    [{ id: "a", path: "/x" }], { timeoutMs: 30000 });
  assert.deepEqual(out3, []);
});

// ---------------------------------------------------------------------------
// V8: worker-environment failures never cost an attempt; short-note gate.
// ---------------------------------------------------------------------------

test("defaultPythonRunner V8: a missing interpreter (spawn ENOENT) maps every job to env_error, no reject", async () => {
  const out = await defaultPythonRunner({ venvPython: "/nonexistent/python", scriptPath: "/nonexistent/w.py", flagPath: NO_FLAG })(
    [{ id: "a", path: "/x" }, { id: "b", path: "/y" }], { timeoutMs: 30000 });
  assert.deepEqual(out, [{ id: "a", error: "env_error" }, { id: "b", error: "env_error" }]);
});

test("defaultPythonRunner V8: an uncaused signal death with zero lines is worker_crash", async () => {
  const script = fakeWorker(`process.kill(process.pid, "SIGSEGV");`);
  const out = await defaultPythonRunner({ venvPython: process.execPath, scriptPath: script, flagPath: NO_FLAG })(
    [{ id: "a", path: "/x" }, { id: "b", path: "/y" }], { timeoutMs: 30000 });
  assert.deepEqual(out, [{ id: "a", error: "worker_crash" }, { id: "b", error: "worker_crash" }]);
});

test("defaultPythonRunner V8: a signal death after one job line returns only that line", async () => {
  const script = fakeWorker(`process.stdout.write(JSON.stringify({ id: jobs[0].id, text: "hi" }) + "\\n",
    () => process.kill(process.pid, "SIGSEGV"));`);
  const out = await defaultPythonRunner({ venvPython: process.execPath, scriptPath: script, flagPath: NO_FLAG })(
    [{ id: "a", path: "/x" }, { id: "b", path: "/y" }], { timeoutMs: 30000 });
  assert.deepEqual(out, [{ id: "a", text: "hi" }]);
});

test("defaultPythonRunner V8: the runner's own timeout kill rejects (stt_error, an attempt)", async () => {
  const script = fakeWorker(`setTimeout(() => {}, 20000);`);
  const run = defaultPythonRunner({ venvPython: process.execPath, scriptPath: script, flagPath: NO_FLAG });
  await assert.rejects(run([{ id: "a", path: "/x" }], { timeoutMs: 200 }), /timeout/);
});

test("transcribeBatch V8: runner env_error / worker_crash via defaultPythonRunner keep their reason", async () => {
  const src = freshSrc();
  const tmp = join(freshDir("tmp"), "voice");
  const cases = [
    ["env_error", defaultPythonRunner({ venvPython: "/nonexistent/python", flagPath: NO_FLAG })],
    ["worker_crash", defaultPythonRunner({ venvPython: process.execPath,
      scriptPath: fakeWorker(`process.kill(process.pid, "SIGSEGV");`), flagPath: NO_FLAG })],
  ];
  for (const [code, runner] of cases) {
    const out = await transcribeBatch([job("a", audio(src, `a8-${code}.opus`), 3)], {
      runner, tmpDir: tmp, flagPath: NO_FLAG, mediaRoot: MEDIA,
    });
    assert.deepEqual(out.map((o) => [o.ok, o.reason]), [[false, code]]);
  }
  const out = await transcribeBatch([job("a", audio(src, "a8-timeout.opus"), 3)], {
    runner: (input) => defaultPythonRunner({ venvPython: process.execPath,
      scriptPath: fakeWorker(`setTimeout(() => {}, 20000);`), flagPath: NO_FLAG })(input, { timeoutMs: 200 }),
    tmpDir: tmp, flagPath: NO_FLAG, mediaRoot: MEDIA,
  });
  assert.deepEqual(out.map((o) => o.reason), ["stt_error"]);
  assert.equal(readdirSync(tmp).length, 0);
});

test("passesQualityGate V8: energy floor binds only notes >= 2 s (or of unknown length)", () => {
  assert.equal(passesQualityGate(good("x", { text: "ok see you there", duration_s: 1.2, speech_s: 0.3 })), true);
  assert.equal(passesQualityGate(good("x", { text: "ok see you there", duration_s: 5, speech_s: 0.3 })), false);
  assert.equal(passesQualityGate(good("x", { text: "ok see you there", duration_s: 2, speech_s: 0.3 })), false);
  // duration_s missing -> strict floor as before.
  assert.equal(passesQualityGate(good("x", { text: "ok see you there", duration_s: undefined, speech_s: 0.3 })), false);
  // short notes still face the text rules.
  assert.equal(passesQualityGate(good("x", { text: "Thank you.", duration_s: 1.2, speech_s: 0.3 })), false);
});

test("passesQualityGate V8: a denylisted phrase repeated 2..4 words under 3 s rejects", () => {
  assert.equal(passesQualityGate(good("x", { text: "Thank you. Thank you.", speech_s: 1 })), false);
  assert.equal(passesQualityGate(good("x", { text: "Obrigado, obrigado.", speech_s: 1 })), false);
  assert.equal(passesQualityGate(good("x", { text: "Thank you. Thank you.", speech_s: 3 })), true);
  // not denylisted -> 2 repeats pass
  assert.equal(passesQualityGate(good("x", { text: "yes yes", speech_s: 1 })), true);
  // existing 3-repeat rule still fires
  assert.equal(passesQualityGate(good("x", { text: "aí aí aí", speech_s: 20 })), false);
  assert.equal(passesQualityGate(good("x", { text: "Okay, okay, okay, okay, sure.", speech_s: 20 })), false);
});

test("passesQualityGate V8: pt/es silence outputs are denylisted under 3 s, pass at >= 3 s", () => {
  for (const text of ["Obrigado.", "Obrigada", "Gracias", "Legendas da comunidade Amara.org",
    "Subtítulos realizados por la comunidad de Amara.org"]) {
    assert.equal(passesQualityGate(good("x", { text, speech_s: 1 })), false, text);
    assert.equal(passesQualityGate(good("x", { text, speech_s: 3 })), true, `${text} @3s`);
  }
});
