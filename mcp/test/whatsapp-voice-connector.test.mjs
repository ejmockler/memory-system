// whatsapp-voice-connector.test.mjs — wa-voice-stt V3: STT wiring inside
// WhatsAppConnector.pollOnce (in-band + late path) and --backfill-voice.
//
// HERMETIC BY CONSTRUCTION (no daemon-activity skip, so it can never pass
// vacuously):
//   - every path is under one mkdtemp root: synthetic ChatStorage built from
//     fixtures/whatsapp-fixture.sql plus voice rows, a fake mediaRoot of dummy
//     .opus files, per-case ledger / cursor / tmp dirs, and a pause flag path;
//   - every connector gets explicit sourceLedgerPath / cursorPath / voice.*
//     paths, so it is correct even under `node --test --test-isolation=none`
//     where lib/config.js may already be cached by another file;
//   - the STT runner is an in-process fake that records its calls. The CLI
//     case points the real defaultPythonRunner at `node fake-stt.mjs` in the
//     tmp root, so no python and no real media is ever touched.
//
// Env is set, and the modules are imported, inside before() — node --test
// loads every file before it runs any test, so a top-level import here would
// pin lib/config.js to this root for sibling files in the same process.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = mkdtempSync(join(tmpdir(), "whatsapp-voice-conn-test-"));
const WHATSAPP_JS = fileURLToPath(new URL("../lib/connectors/whatsapp.js", import.meta.url));
const FIXTURE_SQL = fileURLToPath(new URL("./fixtures/whatsapp-fixture.sql", import.meta.url));

let WhatsAppConnector;
let V;
let stage0;
let DatabaseSync;

before(async () => {
  for (const d of ["policy", "ledgers", "storage/sources", "connectors"]) {
    mkdirSync(join(ROOT, d), { recursive: true });
  }
  process.env.MEMORY_ROOT = ROOT;
  process.env.POLICY_BASE_DIR = join(ROOT, "policy");
  process.env.STORAGE_BASE_DIR = join(ROOT, "storage");
  process.env.LEDGERS_BASE_DIR = join(ROOT, "ledgers");
  process.env.CONNECTORS_BASE_DIR = join(ROOT, "connectors");
  ({ WhatsAppConnector } = await import("../lib/connectors/whatsapp.js"));
  V = await import("../lib/connectors/whatsapp-voice.js");
  ({ stage0 } = await import("../lib/ingest/stage0/whatsapp.js"));
  ({ DatabaseSync } = await import("node:sqlite"));
});

after(() => {
  try { rmSync(ROOT, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// Fixture: fixture.sql + ZMOVIEDURATION + voice rows.
//   Z_PK 9  voice-dm-1     inbound 1:1 voice   (second_party_dm)  5 s
//   Z_PK 10 voice-group-1  inbound group voice (third_party)      4 s
//   Z_PK 11 voice-dm-2     outbound 1:1 voice  (first_party)      3 s
//   Z_PK 12 text-after-voice inbound 1:1 text
// ---------------------------------------------------------------------------
const VOICE_IDS = ["voice-dm-1", "voice-dm-2"];

function voiceSql({ dm1Duration = 5 } = {}) {
  return `
ALTER TABLE ZWAMEDIAITEM ADD COLUMN ZMOVIEDURATION INTEGER;
INSERT INTO ZWAMEDIAITEM (Z_PK, ZMEDIALOCALPATH, ZTITLE, ZMOVIEDURATION)
  VALUES (10, 'Media/voice-dm-1.opus', NULL, ${Number(dm1Duration)});
INSERT INTO ZWAMEDIAITEM (Z_PK, ZMEDIALOCALPATH, ZTITLE, ZMOVIEDURATION)
  VALUES (11, 'Media/voice-group-1.opus', NULL, 4);
INSERT INTO ZWAMEDIAITEM (Z_PK, ZMEDIALOCALPATH, ZTITLE, ZMOVIEDURATION)
  VALUES (12, 'Media/voice-dm-2.opus', NULL, 3);
INSERT INTO ZWAMESSAGE
  (Z_PK, ZSTANZAID, ZTEXT, ZISFROMME, ZMESSAGETYPE, ZGROUPEVENTTYPE,
   ZCHATSESSION, ZPARENTMESSAGE, ZMESSAGEDATE, ZFROMJID, ZTOJID, ZMEDIAITEM)
  VALUES (9, 'voice-dm-1', NULL, 0, 3, 0, 1, NULL, 770000480.0,
          '1234567890@s.whatsapp.net', NULL, 10);
INSERT INTO ZWAMESSAGE
  (Z_PK, ZSTANZAID, ZTEXT, ZISFROMME, ZMESSAGETYPE, ZGROUPEVENTTYPE,
   ZCHATSESSION, ZPARENTMESSAGE, ZMESSAGEDATE, ZFROMJID, ZTOJID, ZMEDIAITEM,
   ZGROUPMEMBER)
  VALUES (10, 'voice-group-1', NULL, 0, 3, 0, 2, NULL, 770000540.0,
          '8888888888@s.whatsapp.net', 'group-1234@g.us', 11, 1);
INSERT INTO ZWAMESSAGE
  (Z_PK, ZSTANZAID, ZTEXT, ZISFROMME, ZMESSAGETYPE, ZGROUPEVENTTYPE,
   ZCHATSESSION, ZPARENTMESSAGE, ZMESSAGEDATE, ZFROMJID, ZTOJID, ZMEDIAITEM)
  VALUES (11, 'voice-dm-2', NULL, 1, 3, 0, 1, NULL, 770000600.0,
          NULL, '1234567890@s.whatsapp.net', 12);
INSERT INTO ZWAMESSAGE
  (Z_PK, ZSTANZAID, ZTEXT, ZISFROMME, ZMESSAGETYPE, ZGROUPEVENTTYPE,
   ZCHATSESSION, ZPARENTMESSAGE, ZMESSAGEDATE, ZFROMJID, ZTOJID, ZMEDIAITEM)
  VALUES (12, 'text-after-voice', 'plain text after the voice notes', 0, 0, 0, 1,
          NULL, 770000660.0, '1234567890@s.whatsapp.net', NULL, NULL);
`;
}

let caseSeq = 0;
function makeEnv(opts = {}) {
  caseSeq += 1;
  const dir = join(ROOT, `case-${caseSeq}`);
  mkdirSync(join(dir, "media", "Media"), { recursive: true });
  const dbPath = join(dir, "chatstorage.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(readFileSync(FIXTURE_SQL, "utf8"));
  db.exec(voiceSql(opts));
  if (typeof opts.extraSql === "string") db.exec(opts.extraSql);
  db.close();
  for (const name of ["voice-dm-1", "voice-group-1", "voice-dm-2", ...(opts.extraMedia || [])]) {
    writeFileSync(join(dir, "media", "Media", `${name}.opus`), Buffer.alloc(4000, 7));
  }
  return {
    dir,
    dbPath,
    mediaRoot: join(dir, "media"),
    flagPath: join(dir, "paused"),
    tmpDir: join(dir, "tmp-voice"),
    ledgerPath: join(dir, "whatsapp.jsonl"),
    cursorPath: join(dir, "state", "state.json"),
  };
}

// Fake runner: records every call; per-id behaviour via `plan`.
//   plan[id] = "throw" | "none" | {text, ...fields}; default = good transcript.
function makeRunner(plan = {}, hooks = {}) {
  const calls = [];
  const runner = async (jobs) => {
    calls.push(jobs.map((j) => ({ id: j.id, path: j.path, exists: existsSync(j.path) })));
    if (typeof hooks.beforeReturn === "function") hooks.beforeReturn(jobs);
    if (jobs.some((j) => plan[j.id] === "throw") || plan.__all === "throw") {
      throw new Error("fake runner failure");
    }
    const out = [];
    for (const j of jobs) {
      const p = plan[j.id];
      if (p === "none") continue;
      out.push({
        id: j.id,
        text: `hello ${j.id}`,
        language: "en",
        avg_logprob: -0.2,
        no_speech_prob: 0.01,
        compression_ratio: 1.2,
        duration_s: 4,
        ...(p && typeof p === "object" ? p : {}),
      });
    }
    return out;
  };
  return { runner, calls, ids: () => calls.flat().map((c) => c.id) };
}

function makeConn(env, { enabled = true, runner, now } = {}) {
  return new WhatsAppConnector({
    chatStoragePath: env.dbPath,
    sourceLedgerPath: env.ledgerPath,
    cursorPath: env.cursorPath,
    now,
    voice: {
      enabled,
      runner: runner || (async () => { throw new Error("runner must not be called"); }),
      mediaRoot: env.mediaRoot,
      tmpDir: env.tmpDir,
      flagPath: env.flagPath,
    },
  });
}

function readLedger(p) {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function readState(env) {
  return JSON.parse(readFileSync(env.cursorPath, "utf8"));
}
function stripVolatile(row) {
  const { id, checksum, ...rest } = row;
  return rest;
}
function byId(rows) {
  return Object.fromEntries(rows.map((r) => [r.source_msg_id, r]));
}
function tmpLeftovers(env) {
  return existsSync(env.tmpDir) ? readdirSync(env.tmpDir) : [];
}

// ---------------------------------------------------------------------------

test("in-band: 1:1 voice transcribed before append; group voice untouched", async () => {
  const env = makeEnv();
  const fake = makeRunner();
  const c = makeConn(env, { runner: fake.runner });
  const res = await c.pollOnce();
  const rows = readLedger(env.ledgerPath);
  const m = byId(rows);

  assert.equal(res.errors, 0);
  assert.equal(fake.calls.length, 1, "exactly one transcribeBatch runner call");
  assert.deepEqual(fake.ids().sort(), [...VOICE_IDS].sort());
  assert.ok(!fake.ids().includes("voice-group-1"), "group voice never reaches the runner");
  assert.ok(fake.calls[0].every((j) => j.exists && j.path.startsWith(env.tmpDir)),
    "runner sees private tmp copies only");
  assert.deepEqual(tmpLeftovers(env), [], "tmp copies unlinked");

  const dm1 = m["voice-dm-1"];
  assert.equal(dm1.raw_content.text, "hello voice-dm-1");
  assert.equal(dm1.raw_content.text_origin, "stt");
  assert.equal(dm1.raw_content.stt.engine, V.STT_ENGINE);
  assert.equal(dm1.raw_content.stt.model, V.DEFAULT_STT_MODEL);
  assert.equal(dm1.raw_content.media_duration_s, 5);
  assert.equal(dm1.source_policy.consent_basis, "second_party_dm");
  assert.equal(m["voice-dm-2"].source_policy.consent_basis, "first_party");
  assert.equal(m["voice-dm-2"].raw_content.text_origin, "stt");
  const d = stage0({ source: "whatsapp", ...dm1 });
  assert.equal(d.decision, "PASS", JSON.stringify(d));

  assert.ok(!rows.some((r) => r.source_msg_id.endsWith("#stt")), "no enrichment rows in-band");

  // Non-transcribed media keeps Stage-0 DROP(media_no_caption).
  const t7 = stage0({ source: "whatsapp", ...m["stanza-msg-7"] });
  assert.deepEqual([t7.decision, t7.reason], ["DROP", "media_no_caption"]);
  const g = m["voice-group-1"];
  assert.equal(g.raw_content.text, null);
  assert.ok(!("text_origin" in g.raw_content) && !("stt" in g.raw_content));
  const gd = stage0({ source: "whatsapp", ...g });
  assert.deepEqual([gd.decision, gd.reason], ["DROP", "media_no_caption"]);

  // Group row is identical (modulo random id/checksum) to a voice-disabled run.
  const env2 = makeEnv();
  await makeConn(env2, { enabled: false }).pollOnce();
  const g2 = byId(readLedger(env2.ledgerPath))["voice-group-1"];
  assert.deepEqual(stripVolatile(g), stripVolatile(g2));

  const st = readState(env);
  assert.equal(st.last_zpk, 12);
  assert.deepEqual(st.voice_pending, []);
  assert.equal(st.voice_pending_n, 0);
  const merged = await c.readCursor();
  assert.deepEqual([...merged.voice_done].sort(), [...VOICE_IDS].sort());
  assert.ok(!("voice_done" in st), "voice_done lives in the heavy sidecar");
  const stateBytes = readFileSync(env.cursorPath, "utf8")
    + readFileSync(c.heavyCursorPath, "utf8");
  assert.ok(!stateBytes.includes("hello voice"), "no transcript text in state");
  assert.equal(st.stt_last_batch.n, 2);
  const h = c.reportHealth();
  assert.equal(h.voice_pending_n, 0);
  assert.equal(h.stt_last_batch.n, 2);
});

test("paused: runner not called, cursor identical to voice-disabled; unpause emits one #stt per note; third poll is a no-op", async () => {
  const envOff = makeEnv();
  await makeConn(envOff, { enabled: false }).pollOnce();
  const offState = readState(envOff);
  const offRows = readLedger(envOff.ledgerPath);

  const env = makeEnv();
  writeFileSync(env.flagPath, "");
  const fake = makeRunner();
  let clock = Date.parse("2026-09-01T00:00:00.000Z");
  const now = () => new Date(clock).toISOString();
  const c = makeConn(env, { runner: fake.runner, now });

  await c.pollOnce();
  assert.equal(fake.calls.length, 0, "paused: zero runner calls");
  assert.deepEqual(tmpLeftovers(env), []);
  const s1 = readState(env);
  assert.equal(s1.last_zpk, offState.last_zpk);
  assert.equal(s1.last_message_date, offState.last_message_date);
  const rows1 = readLedger(env.ledgerPath);
  assert.deepEqual(rows1.map((r) => r.source_msg_id), offRows.map((r) => r.source_msg_id),
    "text rows (and untranscribed voice rows) still appended");
  assert.deepEqual(rows1.map(stripVolatile), offRows.map(stripVolatile));
  assert.deepEqual(s1.voice_pending.map((e) => e.stanza).sort(), [...VOICE_IDS].sort());
  for (const e of s1.voice_pending) {
    assert.equal(e.reason, "paused");
    assert.equal(e.attempts, 0);
    assert.equal(e.first_seen, "2026-09-01T00:00:00.000Z");
    assert.ok(Number.isInteger(e.zpk));
  }
  assert.equal(s1.voice_pending_n, 2);

  // A still-paused poll changes nothing and calls nothing.
  clock += 60_000;
  await c.pollOnce();
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(readState(env), s1);

  // Unpause: late path emits exactly one "#stt" per 1:1 note.
  unlinkSync(env.flagPath);
  clock += 60_000;
  await c.pollOnce();
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.ids().sort(), [...VOICE_IDS].sort());
  const rows2 = readLedger(env.ledgerPath);
  const stt = rows2.filter((r) => r.source_msg_id.endsWith("#stt"));
  assert.equal(stt.length, 2);
  const parents = byId(rows2);
  for (const r of stt) {
    const pid = r.source_msg_id.slice(0, -4);
    assert.equal(r.kind, "voice_transcript");
    assert.deepEqual(r.derived_from, [pid]);
    assert.equal(r.ts, parents[pid].ts);
    assert.deepEqual(r.parties, parents[pid].parties);
    assert.equal(r.source_policy.consent_basis, parents[pid].source_policy.consent_basis);
    assert.equal(r.raw_content.text, `hello ${pid}`);
    assert.equal(r.raw_content.text_origin, "stt");
  }
  const s2 = readState(env);
  assert.deepEqual(s2.voice_pending, []);
  assert.equal(s2.last_zpk, s1.last_zpk);
  assert.equal(s2.last_cursor_advance_ts, s1.last_cursor_advance_ts,
    "voice-only write never stamps last_cursor_advance_ts");
  assert.equal(s2.last_appended_ts, s1.last_appended_ts,
    "voice-only write never stamps last_appended_ts");
  assert.deepEqual([...(await c.readCursor()).voice_done].sort(), [...VOICE_IDS].sort());

  // Third poll: nothing new.
  clock += 60_000;
  await c.pollOnce();
  assert.equal(fake.calls.length, 1);
  assert.equal(readLedger(env.ledgerPath).length, rows2.length);
});

test("runner throw: jobs go to voice_pending, cursor still advances; attempts cap retires to voice_failed", async () => {
  const env = makeEnv();
  const fake = makeRunner({ __all: "throw" });
  const c = makeConn(env, { runner: fake.runner });
  const r = await c.pollOnce();
  assert.equal(r.errors, 0);
  let st = readState(env);
  assert.equal(st.last_zpk, 12, "STT failure never holds the cursor");
  assert.deepEqual(st.voice_pending.map((e) => [e.stanza, e.reason, e.attempts]).sort(),
    VOICE_IDS.map((id) => [id, "stt_error", 1]).sort());
  assert.deepEqual(tmpLeftovers(env), []);

  await c.pollOnce();
  st = readState(env);
  assert.deepEqual(st.voice_pending.map((e) => e.attempts), [2, 2]);
  await c.pollOnce();
  st = readState(env);
  assert.deepEqual(st.voice_pending, []);
  assert.deepEqual(st.voice_failed.map((e) => e.stanza).sort(), [...VOICE_IDS].sort());
  assert.equal(st.voice_failed_n, 2);
  const calls = fake.calls.length;
  await c.pollOnce();
  assert.equal(fake.calls.length, calls, "voice_failed is never retried");
  assert.equal(st.last_zpk, 12);
});

test("mid-batch pause: flag written DURING the runner turns no_result into 'paused', no attempt", async () => {
  const env = makeEnv();
  // gamepause touches the flag BEFORE it kills the worker: the runner sees
  // the flag appear and then returns nothing for its jobs.
  const fake = makeRunner({ "voice-dm-1": "none", "voice-dm-2": "none" }, {
    beforeReturn: () => writeFileSync(env.flagPath, ""),
  });
  const c = makeConn(env, { runner: fake.runner });
  await c.pollOnce();
  assert.equal(fake.calls.length, 1);
  const st = readState(env);
  assert.deepEqual(st.voice_pending.map((e) => [e.stanza, e.reason, e.attempts]).sort(),
    VOICE_IDS.map((id) => [id, "paused", 0]).sort());
  assert.equal(st.last_zpk, 12);
  // A runner throw under the same pause ordering is also 'paused'.
  const env2 = makeEnv();
  const thrower = makeRunner({ __all: "throw" }, {
    beforeReturn: () => writeFileSync(env2.flagPath, ""),
  });
  await makeConn(env2, { runner: thrower.runner }).pollOnce();
  assert.deepEqual(readState(env2).voice_pending.map((e) => [e.reason, e.attempts]),
    [["paused", 0], ["paused", 0]]);
});

test("quality_gate and too_long are terminal: voice_failed, never retried", async () => {
  const env = makeEnv({ dm1Duration: V.MAX_JOB_AUDIO_S + 1 });
  const fake = makeRunner({ "voice-dm-2": { compression_ratio: 3.1 } });
  const c = makeConn(env, { runner: fake.runner });
  await c.pollOnce();
  assert.deepEqual(fake.ids(), ["voice-dm-2"], "too_long never reaches the runner");
  const st = readState(env);
  assert.deepEqual(st.voice_pending, []);
  const reasons = Object.fromEntries(st.voice_failed.map((e) => [e.stanza, e.reason]));
  assert.deepEqual(reasons, { "voice-dm-1": "too_long", "voice-dm-2": "quality_gate" });
  const m = byId(readLedger(env.ledgerPath));
  assert.equal(m["voice-dm-2"].raw_content.text, null, "rejected transcript is not appended");
  await c.pollOnce();
  assert.equal(fake.calls.length, 1, "terminal failures are not retried");
});

test("not_eligible is terminal: a parked job whose row is no longer a candidate goes to voice_failed", async () => {
  const env = makeEnv();
  writeFileSync(env.flagPath, "");
  const fake = makeRunner();
  const c = makeConn(env, { runner: fake.runner });
  await c.pollOnce();
  assert.equal(readState(env).voice_pending.length, 2);
  // The DB row gains a caption; the late path re-reads it and V1 re-checks.
  const db = new DatabaseSync(env.dbPath);
  db.prepare("UPDATE ZWAMESSAGE SET ZTEXT = 'caption now' WHERE ZSTANZAID = 'voice-dm-1'").run();
  db.close();
  unlinkSync(env.flagPath);
  await c.pollOnce();
  assert.deepEqual(fake.ids(), ["voice-dm-2"], "ineligible job never reaches the runner");
  const st = readState(env);
  assert.deepEqual(st.voice_pending, []);
  assert.deepEqual(st.voice_failed.map((e) => [e.stanza, e.reason]), [["voice-dm-1", "not_eligible"]]);
  await c.pollOnce();
  assert.equal(fake.calls.length, 1, "never retried");
});

test("voice_failed stays capped at 50", async () => {
  const n = 55;
  let sql = "";
  const extraMedia = [];
  for (let k = 0; k < n; k += 1) {
    const mediaPk = 100 + k;
    const msgPk = 100 + k;
    extraMedia.push(`qg-${k}`);
    sql += `INSERT INTO ZWAMEDIAITEM (Z_PK, ZMEDIALOCALPATH, ZMOVIEDURATION)
      VALUES (${mediaPk}, 'Media/qg-${k}.opus', 2);
    INSERT INTO ZWAMESSAGE (Z_PK, ZSTANZAID, ZTEXT, ZISFROMME, ZMESSAGETYPE,
      ZGROUPEVENTTYPE, ZCHATSESSION, ZMESSAGEDATE, ZFROMJID, ZMEDIAITEM)
      VALUES (${msgPk}, 'qg-${k}', NULL, 0, 3, 0, 1, ${770001000 + k}.0,
        '1234567890@s.whatsapp.net', ${mediaPk});\n`;
  }
  const env = makeEnv({ extraSql: sql, extraMedia });
  const plan = {};
  for (let k = 0; k < n; k += 1) plan[`qg-${k}`] = { no_speech_prob: 0.9, avg_logprob: -2 };
  const fake = makeRunner(plan);
  await makeConn(env, { runner: fake.runner }).pollOnce();
  const st = readState(env);
  assert.equal(st.voice_failed.length, 50);
  assert.equal(st.voice_failed_n, 50);
  assert.equal(st.voice_failed.at(-1).stanza, "qg-54");
  assert.ok(st.voice_failed.every((e) => e.reason === "quality_gate"));
});

test("poison row: a persistent append failure defers in-band STT (no runner call), backoff clears once the cursor passes it", async () => {
  const env = makeEnv();
  const fake = makeRunner();
  const c = makeConn(env, { runner: fake.runner });
  const append = c.appendLedgerRow.bind(c);
  let armed = true;
  c.appendLedgerRow = async (row) => {
    if (armed && row.source_msg_id === "voice-dm-2") throw new Error("planted");
    return append(row);
  };
  const r1 = await c.pollOnce();
  assert.equal(r1.errors, 1);
  let st = readState(env);
  assert.equal(st.last_zpk, 10, "cursor stops before the failed row");
  assert.equal(st.voice_backoff_zpk, 11, "failed row's Z_PK persisted");
  let merged = await c.readCursor();
  assert.deepEqual(merged.voice_done, ["voice-dm-1"]);
  assert.deepEqual(merged.voice_pending, []);
  assert.equal(fake.calls.length, 1);

  // Still failing: the runner is NOT called again for the poison row.
  const r2 = await c.pollOnce();
  assert.equal(r2.errors, 1);
  assert.equal(fake.calls.length, 1, "second poll: runner call count unchanged");
  st = readState(env);
  assert.equal(st.last_zpk, 10, "cursor still stops at the failed row");
  assert.equal(st.voice_backoff_zpk, 11);

  // Failure clears: the row appends untranscribed, parks as 'deferred', and
  // the backoff clears because last_zpk moved past it.
  armed = false;
  const r3 = await c.pollOnce();
  assert.equal(r3.errors, 0);
  assert.equal(fake.calls.length, 1, "deferred rows never reach the runner in-band");
  st = readState(env);
  assert.equal(st.last_zpk, 12);
  assert.ok(!("voice_backoff_zpk" in st), "backoff cleared once last_zpk > it");
  assert.deepEqual(st.voice_pending.map((e) => [e.stanza, e.reason, e.attempts]),
    [["voice-dm-2", "deferred", 0]]);
  assert.equal(byId(readLedger(env.ledgerPath))["voice-dm-2"].raw_content.text, null);

  // Next tick: the late path emits its "#stt" row.
  await c.pollOnce();
  assert.deepEqual(fake.ids(), ["voice-dm-1", "voice-dm-2", "voice-dm-2"]);
  const stt = readLedger(env.ledgerPath).filter((r) => r.source_msg_id.endsWith("#stt"));
  assert.deepEqual(stt.map((r) => r.source_msg_id), ["voice-dm-2#stt"]);
  merged = await c.readCursor();
  assert.deepEqual(merged.voice_pending, []);
  assert.deepEqual([...merged.voice_done].sort(), [...VOICE_IDS].sort());
});

test("store rebuild: in-band transcript on a deduped row is not voice_done; late path emits one #stt per note; backfill transcribes 0", async () => {
  const env = makeEnv();
  await makeConn(env, { enabled: false }).pollOnce();
  const fake = makeRunner();
  const c = makeConn(env, { runner: fake.runner });
  // Simulated rebuild: stranded high-water Z_PK, date anchor below the notes.
  const cur = await c.readCursor();
  await c.writeCursor({ ...cur, last_zpk: 9999, last_message_date: 770000400 });

  const r = await c.pollOnce();
  assert.equal(r.errors, 0);
  assert.equal(r.appended, 0, "every recovered row dedups");
  const rows = readLedger(env.ledgerPath);
  for (const id of VOICE_IDS) {
    assert.equal(rows.filter((x) => x.source_msg_id === `${id}#stt`).length, 1, `one #stt for ${id}`);
  }
  assert.ok(!rows.some((x) => x.source_msg_id === "voice-group-1#stt"));
  assert.equal(rows.filter((x) => x.source_msg_id.endsWith("#stt")).length, 2);
  const st = readState(env);
  assert.equal(st.last_zpk, 12, "recovery adopts the rebuilt store's MAX(Z_PK)");
  assert.deepEqual(st.voice_pending, []);
  assert.deepEqual([...(await c.readCursor()).voice_done].sort(), [...VOICE_IDS].sort());

  const calls = fake.calls.length;
  const summary = await c.backfillVoice();
  assert.equal(summary.transcribed, 0);
  assert.ok(!("voice_done" in summary.skipped), JSON.stringify(summary));
  assert.equal(summary.skipped.stt_exists, 2);
  assert.equal(fake.calls.length, calls, "backfill never re-runs STT");
});

test("unchanged 'unreadable' retry leaves state.json mtime and bytes identical", async () => {
  const env = makeEnv();
  unlinkSync(join(env.mediaRoot, "Media", "voice-dm-1.opus"));
  let clock = Date.parse("2026-09-01T00:00:00.000Z");
  const now = () => new Date(clock).toISOString();
  const fake = makeRunner();
  const c = makeConn(env, { runner: fake.runner, now });
  await c.pollOnce();
  const st1 = readState(env);
  assert.deepEqual(st1.voice_pending.map((e) => [e.stanza, e.reason, e.attempts]),
    [["voice-dm-1", "unreadable", 0]]);
  const bytes1 = readFileSync(env.cursorPath);
  const mtime1 = statSync(env.cursorPath).mtimeMs;
  const heavy1 = readFileSync(c.heavyCursorPath);
  await new Promise((r) => setTimeout(r, 30));
  clock += 60_000;
  await c.pollOnce();
  clock += 60_000;
  await c.pollOnce();
  assert.equal(statSync(env.cursorPath).mtimeMs, mtime1, "state.json not rewritten");
  assert.ok(readFileSync(env.cursorPath).equals(bytes1), "state.json bytes identical");
  assert.ok(readFileSync(c.heavyCursorPath).equals(heavy1), "heavy sidecar identical");
  assert.deepEqual(readState(env).stt_last_batch, st1.stt_last_batch, "stt_last_batch not overwritten");
});

test("NULL media at first poll: pending 'no_media' without a job; transcribed by the late path once downloaded", async () => {
  const env = makeEnv({ extraSql: "UPDATE ZWAMEDIAITEM SET ZMEDIALOCALPATH = NULL WHERE Z_PK = 10;" });
  const fake = makeRunner();
  const c = makeConn(env, { runner: fake.runner });
  await c.pollOnce();
  assert.deepEqual(fake.ids(), ["voice-dm-2"], "no job for the not-downloaded note");
  let st = readState(env);
  assert.equal(st.last_zpk, 12);
  assert.deepEqual(st.voice_pending.map((e) => [e.stanza, e.reason, e.attempts]),
    [["voice-dm-1", "no_media", 0]]);
  const dm1 = byId(readLedger(env.ledgerPath))["voice-dm-1"];
  assert.equal(dm1.raw_content.media_local_path, null);
  assert.equal(dm1.raw_content.text, null);

  // Still not downloaded: nothing runs, nothing is rewritten.
  const bytes = readFileSync(env.cursorPath);
  await c.pollOnce();
  assert.equal(fake.calls.length, 1);
  assert.ok(readFileSync(env.cursorPath).equals(bytes));

  // WhatsApp downloads it: the late path re-reads by Z_PK and transcribes.
  const db = new DatabaseSync(env.dbPath);
  db.prepare("UPDATE ZWAMEDIAITEM SET ZMEDIALOCALPATH = 'Media/voice-dm-1.opus' WHERE Z_PK = 10").run();
  db.close();
  await c.pollOnce();
  assert.deepEqual(fake.ids(), ["voice-dm-2", "voice-dm-1"]);
  const stt = readLedger(env.ledgerPath).filter((r) => r.source_msg_id.endsWith("#stt"));
  assert.deepEqual(stt.map((r) => r.source_msg_id), ["voice-dm-1#stt"]);
  assert.equal(stt[0].raw_content.text, "hello voice-dm-1");
  assert.equal(stt[0].source_policy.consent_basis, "second_party_dm");
  st = readState(env);
  assert.deepEqual(st.voice_pending, []);
  assert.ok((await c.readCursor()).voice_done.includes("voice-dm-1"));
});

test("row shape: raw_content key sets are fixed; media_duration_s only when finite", async () => {
  const env = makeEnv();
  await makeConn(env, { enabled: false }).pollOnce();
  const m = byId(readLedger(env.ledgerPath));
  const TEXT_KEYS = [
    "text", "from_jid", "to_jid", "session_jid", "session_partner_name",
    "session_label", "sender_jid", "sender_name", "is_from_me", "message_type",
    "group_event_type", "session_type", "message_date_coredata", "has_media",
    "media_local_path", "media_url", "media_title", "starred",
    "low_signal_message_type", "identifier_body_placeholder",
  ];
  assert.deepEqual(Object.keys(m["stanza-msg-2"].raw_content), TEXT_KEYS);
  assert.ok(!("media_duration_s" in m["stanza-msg-2"].raw_content));
  const VOICE_KEYS = [...TEXT_KEYS];
  VOICE_KEYS.splice(VOICE_KEYS.indexOf("media_title") + 1, 0, "media_duration_s");
  assert.deepEqual(Object.keys(m["voice-group-1"].raw_content), VOICE_KEYS);
  assert.equal(m["voice-group-1"].raw_content.media_duration_s, 4);
});

test("voice disabled: no runner, no voice state keys", async () => {
  const env = makeEnv();
  await makeConn(env, { enabled: false }).pollOnce();
  const st = readState(env);
  assert.ok(!Object.keys(st).some((k) => k.startsWith("voice_") || k === "stt_last_batch"));
});

// ---------------------------------------------------------------------------
// Backfill over a synthetic ledger.
// ---------------------------------------------------------------------------
async function seedBackfillLedger(env) {
  // Real connector-shaped rows for the fixture + voice rows (voice disabled).
  const c = makeConn(env, { enabled: false });
  await c.pollOnce();
  const dm = (sid, extra = {}) => ({
    ts: "2026-09-01T00:00:00.000Z",
    source_msg_id: sid,
    parties: ["1234567890@s.whatsapp.net", "user"],
    raw_content: {
      text: null,
      from_jid: "1234567890@s.whatsapp.net",
      session_jid: "1234567890@s.whatsapp.net",
      is_from_me: 0,
      message_type: 3,
      session_type: 0,
      has_media: true,
      media_local_path: "Media/voice-dm-1.opus",
      media_duration_s: 5,
      ...extra,
    },
    attachments: [],
  });
  // 1:1 voice with text already (in-band earlier) -> has_text.
  await c.appendLedgerRow(dm("bf-text", { text: "already here" }));
  // voice row whose #stt already exists -> stt_exists.
  await c.appendLedgerRow(dm("bf-stt"));
  await c.appendLedgerRow({ ...dm("bf-stt#stt", { text: "old" }), kind: "voice_transcript", derived_from: ["bf-stt"] });
  // voice row already in voice_done -> voice_done.
  await c.appendLedgerRow(dm("bf-done"));
  // message_type 32 / 34 lookalikes, fully 1:1-shaped: must be ignored.
  await c.appendLedgerRow(dm("bf-32", { message_type: 32 }));
  await c.appendLedgerRow(dm("bf-34", { message_type: 34 }));
  // A duplicated line for voice-dm-1 (dedup by source_msg_id).
  const lines = readFileSync(env.ledgerPath, "utf8").split("\n").filter(Boolean);
  const dup = lines.find((l) => JSON.parse(l).source_msg_id === "voice-dm-1");
  writeFileSync(env.ledgerPath, lines.join("\n") + "\n" + dup + "\n");
  await c.writeCursor({ ...((await c.readCursor()) || {}), voice_done: ["bf-done"] });
}

const BACKFILL_EXPECTED = {
  candidates: 6, // voice-dm-1, voice-group-1, voice-dm-2, bf-text, bf-stt, bf-done
  transcribed: 2,
  skipped: { not_eligible: 1, has_text: 1, stt_exists: 1, voice_done: 1 },
};

test("backfillVoice: expected counts, ignores message_type 32/34, idempotent", async () => {
  const env = makeEnv();
  await seedBackfillLedger(env);
  const fake = makeRunner();
  const c = makeConn(env, { runner: fake.runner });
  const before = readState(env);
  const summary = await c.backfillVoice();
  assert.deepEqual(summary, BACKFILL_EXPECTED);
  assert.deepEqual(fake.ids().sort(), [...VOICE_IDS].sort());
  const rows = readLedger(env.ledgerPath);
  const stt = rows.filter((r) => r.source_msg_id.endsWith("#stt") && r.source_msg_id !== "bf-stt#stt");
  assert.deepEqual(stt.map((r) => r.source_msg_id).sort(), VOICE_IDS.map((x) => `${x}#stt`).sort());
  const parents = byId(rows);
  for (const r of stt) {
    const pid = r.derived_from[0];
    assert.equal(r.source_policy.consent_basis, parents[pid].source_policy.consent_basis);
  }
  const after = readState(env);
  assert.equal(after.last_zpk, before.last_zpk);
  assert.equal(after.last_cursor_advance_ts, before.last_cursor_advance_ts);
  assert.equal(after.last_appended_ts, before.last_appended_ts);

  const again = await c.backfillVoice();
  assert.deepEqual(again, {
    candidates: 6,
    transcribed: 0,
    // Transcripts in the ledger are reported as such; voice_done only names
    // bf-done, which is marked done with neither text nor a "#stt" row.
    skipped: { not_eligible: 1, has_text: 1, stt_exists: 3, voice_done: 1 },
  });
  assert.equal(fake.calls.length, 1);
  assert.equal(readLedger(env.ledgerPath).length, rows.length);
});

test("CLI --backfill-voice prints only the JSON summary, never transcript text", async () => {
  const cliRoot = join(ROOT, "cli");
  const env = {
    ...makeEnv(),
  };
  // The CLI resolves ledger + state from MEMORY_ROOT/CONNECTORS_BASE_DIR.
  env.ledgerPath = join(cliRoot, "storage", "sources", "whatsapp.jsonl");
  env.cursorPath = join(cliRoot, "connectors", "whatsapp", "state.json");
  mkdirSync(join(cliRoot, "storage", "sources"), { recursive: true });
  await seedBackfillLedger(env);

  const callsFile = join(cliRoot, "fake-stt-calls.jsonl");
  const fakeScript = join(cliRoot, "fake-stt.mjs");
  writeFileSync(fakeScript, `
import { appendFileSync, existsSync } from "node:fs";
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { buf += c; });
process.stdin.on("end", () => {
  const jobs = JSON.parse(buf);
  appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(jobs.map((j) => ({ id: j.id, exists: existsSync(j.path) }))) + "\\n");
  for (const j of jobs) {
    process.stdout.write(JSON.stringify({ id: j.id, text: "SECRET TRANSCRIPT " + j.id,
      language: "en", avg_logprob: -0.1, no_speech_prob: 0.01, compression_ratio: 1.1, duration_s: 3 }) + "\\n");
  }
});
`);
  const res = spawnSync(process.execPath, [WHATSAPP_JS, "--backfill-voice"], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      PATH: process.env.PATH,
      HOME: cliRoot,
      MEMORY_ROOT: cliRoot,
      POLICY_BASE_DIR: join(cliRoot, "policy"),
      STORAGE_BASE_DIR: join(cliRoot, "storage"),
      LEDGERS_BASE_DIR: join(cliRoot, "ledgers"),
      CONNECTORS_BASE_DIR: join(cliRoot, "connectors"),
      WHATSAPP_STT_PYTHON: process.execPath,
      WHATSAPP_STT_SCRIPT: fakeScript,
      WHATSAPP_VOICE_MEDIA_ROOT: env.mediaRoot,
      WHATSAPP_VOICE_PAUSE_FLAG: env.flagPath,
      WHATSAPP_VOICE_TMP_DIR: env.tmpDir,
    },
  });
  assert.equal(res.status, 0, `stderr=${res.stderr}`);
  assert.equal(res.stderr, "");
  const lines = res.stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, "stdout is exactly one JSON line");
  const summary = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(summary).sort(), ["candidates", "skipped", "transcribed"]);
  assert.deepEqual(summary, BACKFILL_EXPECTED);
  assert.ok(!res.stdout.includes("SECRET") && !res.stderr.includes("SECRET"));
  const calls = readFileSync(callsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(calls.flat().map((c) => c.id).sort(), [...VOICE_IDS].sort());
  assert.ok(calls.flat().every((c) => c.exists));
  assert.deepEqual(tmpLeftovers(env), []);
  const stt = readLedger(env.ledgerPath).filter((r) => r.raw_content?.text?.startsWith("SECRET"));
  assert.equal(stt.length, 2, "transcripts land only in the ledger");
  const stateText = readFileSync(env.cursorPath, "utf8");
  assert.ok(!stateText.includes("SECRET"));
});

// --- wave-5 fixes: late-path starvation, backoff boundary, crash replay ----

function voiceNoteSql(pk, stanza, { media = null, date } = {}) {
  const path = media == null ? "NULL" : `'${media}'`;
  return `INSERT INTO ZWAMEDIAITEM (Z_PK, ZMEDIALOCALPATH, ZMOVIEDURATION)
      VALUES (${pk}, ${path}, 2);
    INSERT INTO ZWAMESSAGE (Z_PK, ZSTANZAID, ZTEXT, ZISFROMME, ZMESSAGETYPE,
      ZGROUPEVENTTYPE, ZCHATSESSION, ZMESSAGEDATE, ZFROMJID, ZMEDIAITEM)
      VALUES (${pk}, '${stanza}', NULL, 0, 3, 0, 1, ${date}.0,
        '1234567890@s.whatsapp.net', ${pk});\n`;
}

test("late-path starvation: 25 no_media entries never crowd out stt_error retries", async () => {
  const n = 25;
  let sql = "";
  for (let k = 0; k < n; k += 1) sql += voiceNoteSql(100 + k, `nm-${k}`, { date: 770001000 + k });
  const env = makeEnv({ extraSql: sql, extraMedia: ["err-1", "err-2"] });
  const plan = { "err-1": "throw", "err-2": "throw" };
  const fake = makeRunner(plan);
  const c = makeConn(env, { runner: fake.runner });
  await c.pollOnce();
  let st = readState(env);
  assert.equal(st.voice_pending.filter((e) => e.reason === "no_media").length, n);

  // Two new 1:1 notes whose STT errors, parked AFTER the 25 no_media entries.
  const db = new DatabaseSync(env.dbPath);
  db.exec(voiceNoteSql(200, "err-1", { media: "Media/err-1.opus", date: 770002000 })
    + voiceNoteSql(201, "err-2", { media: "Media/err-2.opus", date: 770002001 }));
  db.close();
  await c.pollOnce();
  st = readState(env);
  assert.deepEqual(st.voice_pending.filter((e) => e.reason === "stt_error")
    .map((e) => [e.stanza, e.attempts]), [["err-1", 1], ["err-2", 1]]);
  assert.deepEqual(st.voice_pending.slice(0, n).map((e) => e.reason),
    Array(n).fill("no_media"), "stt_error entries sit behind every no_media entry");
  const noMedia0 = st.voice_pending.filter((e) => e.reason === "no_media");
  const callsBefore = fake.calls.length;

  // Next tick: the runner gets both stt_error stanzas.
  delete plan["err-1"];
  delete plan["err-2"];
  await c.pollOnce();
  assert.deepEqual(fake.calls.slice(callsBefore).flat().map((x) => x.id).sort(), ["err-1", "err-2"]);
  const stt = readLedger(env.ledgerPath).filter((r) => r.source_msg_id.endsWith("#stt"));
  assert.deepEqual(stt.map((r) => r.source_msg_id).sort(), ["err-1#stt", "err-2#stt"]);
  st = readState(env);
  assert.deepEqual(st.voice_pending, noMedia0, "no_media entries untouched (same fields, same order)");

  // A tick where only unchanged no_media probes remain rewrites nothing.
  const bytes = readFileSync(env.cursorPath);
  const mtime = statSync(env.cursorPath).mtimeMs;
  const calls = fake.calls.length;
  await new Promise((r) => setTimeout(r, 30));
  await c.pollOnce();
  assert.equal(fake.calls.length, calls);
  assert.equal(statSync(env.cursorPath).mtimeMs, mtime, "state.json not rewritten");
  assert.ok(readFileSync(env.cursorPath).equals(bytes));
});

test("backoff: a poison row that is the newest row clears once last_zpk equals it; next note is transcribed in-band", async () => {
  const env = makeEnv({ extraMedia: ["fresh-1"] });
  const fake = makeRunner();
  const c = makeConn(env, { runner: fake.runner });
  const append = c.appendLedgerRow.bind(c);
  let armed = true;
  c.appendLedgerRow = async (row) => {
    if (armed && row.source_msg_id === "text-after-voice") throw new Error("planted");
    return append(row);
  };
  const r1 = await c.pollOnce();
  assert.equal(r1.errors, 1);
  let st = readState(env);
  assert.equal(st.last_zpk, 11);
  assert.equal(st.voice_backoff_zpk, 12, "newest row is the poison row");

  armed = false;
  const r2 = await c.pollOnce();
  assert.equal(r2.errors, 0);
  st = readState(env);
  assert.equal(st.last_zpk, 12);
  assert.ok(!("voice_backoff_zpk" in st), "backoff cleared once last_zpk === backoff");

  const db = new DatabaseSync(env.dbPath);
  db.exec(voiceNoteSql(13, "fresh-1", { media: "Media/fresh-1.opus", date: 770000700 }));
  db.close();
  const calls = fake.calls.length;
  await c.pollOnce();
  assert.deepEqual(fake.calls.slice(calls).flat().map((x) => x.id), ["fresh-1"], "runner called in-band");
  const fresh = byId(readLedger(env.ledgerPath))["fresh-1"];
  assert.equal(fresh.raw_content.text, "hello fresh-1");
  assert.equal(fresh.raw_content.text_origin, "stt");
  assert.ok(!readLedger(env.ledgerPath).some((r) => r.source_msg_id === "fresh-1#stt"));
  st = readState(env);
  assert.equal(st.last_zpk, 13);
  assert.deepEqual(st.voice_pending, []);
});

test("crash replay: in-band transcript appended but state write lost -> no #stt row, voice_done set, runner <= 1 call on replay", async () => {
  const env = makeEnv();
  const fake1 = makeRunner();
  const c1 = makeConn(env, { runner: fake1.runner });
  // Simulated crash between the ledger append and the state write.
  c1.writeCursor = async () => {};
  await c1.pollOnce();
  assert.ok(!existsSync(env.cursorPath), "state write suppressed");
  assert.ok(!existsSync(c1.heavyCursorPath));
  const m = byId(readLedger(env.ledgerPath));
  for (const id of VOICE_IDS) assert.equal(m[id].raw_content.text_origin, "stt");

  const fake2 = makeRunner();
  const c2 = makeConn(env, { runner: fake2.runner });
  const r = await c2.pollOnce();
  assert.equal(r.errors, 0);
  assert.equal(r.appended, 0, "replayed rows dedup");
  const rows = readLedger(env.ledgerPath);
  assert.equal(rows.filter((x) => x.source_msg_id.endsWith("#stt")).length, 0, "no #stt rows");
  for (const id of VOICE_IDS) {
    assert.ok(fake2.ids().filter((x) => x === id).length <= 1, `runner called at most once for ${id}`);
  }
  const merged = await c2.readCursor();
  assert.deepEqual([...merged.voice_done].sort(), [...VOICE_IDS].sort());
  assert.deepEqual(merged.voice_pending, []);
  assert.equal(merged.last_zpk, 12);

  // A further tick does nothing more.
  const calls = fake2.calls.length;
  await c2.pollOnce();
  assert.equal(fake2.calls.length, calls);
  assert.equal(readLedger(env.ledgerPath).length, rows.length);
});

// --- V5: late-path residuals (row_gone before the cap, dedup-time replay) ---

async function seedGonePending(env, c, n, { prefix = "gone" } = {}) {
  // Rows that existed once and were deleted from ChatStorage.
  const db = new DatabaseSync(env.dbPath);
  let sql = "";
  for (let k = 0; k < n; k += 1) sql += voiceNoteSql(300 + k, `${prefix}-${k}`, { date: 770003000 + k });
  db.exec(sql);
  db.exec(`DELETE FROM ZWAMESSAGE WHERE Z_PK >= 300 AND Z_PK < ${300 + n};`);
  db.close();
  const firstSeen = new Date(Date.now() - 60_000).toISOString();
  const gone = [];
  for (let k = 0; k < n; k += 1) {
    gone.push({ zpk: 300 + k, stanza: `${prefix}-${k}`, first_seen: firstSeen, attempts: 0, reason: "deferred" });
  }
  const cur = await c.readCursor();
  const pending = [...gone, ...(cur.voice_pending || [])];
  await c.writeCursor({ ...cur, voice_pending: pending, voice_pending_n: pending.length });
  return gone.map((e) => e.stanza);
}

test("row_gone: 25 invisible deferred entries retire in one tick; stt_error retries are not starved", async () => {
  const sql = voiceNoteSql(200, "err-1", { media: "Media/err-1.opus", date: 770002000 })
    + voiceNoteSql(201, "err-2", { media: "Media/err-2.opus", date: 770002001 });
  const env = makeEnv({ extraSql: sql, extraMedia: ["err-1", "err-2"] });
  const plan = { "err-1": "throw", "err-2": "throw" };
  const fake = makeRunner(plan);
  const c = makeConn(env, { runner: fake.runner });
  await c.pollOnce();
  let st = readState(env);
  // The runner throw fails the whole in-band batch: every 1:1 note parks.
  const errIds = [...VOICE_IDS, "err-1", "err-2"].sort();
  assert.deepEqual(st.voice_pending.map((e) => e.reason), Array(4).fill("stt_error"));
  assert.deepEqual(st.voice_pending.map((e) => e.stanza).sort(), errIds);

  const goneIds = await seedGonePending(env, c, 25);
  delete plan["err-1"];
  delete plan["err-2"];
  const callsBefore = fake.calls.length;
  await c.pollOnce();

  const called = fake.calls.slice(callsBefore).flat().map((x) => x.id);
  assert.deepEqual([...called].sort(), errIds, "runner gets every stt_error stanza");
  assert.ok(called.includes("err-1") && called.includes("err-2"));
  assert.ok(!called.some((id) => goneIds.includes(id)), "no row_gone stanza reaches the runner");
  st = readState(env);
  const failed = st.voice_failed.filter((f) => f.reason === "row_gone").map((f) => f.stanza);
  assert.deepEqual([...failed].sort(), [...goneIds].sort(), "all 25 retired as row_gone");
  assert.ok(!st.voice_pending.some((e) => goneIds.includes(e.stanza)), "none left pending");
  assert.deepEqual(st.voice_pending, []);
  const stt = readLedger(env.ledgerPath).filter((r) => r.source_msg_id.endsWith("#stt"));
  assert.deepEqual(stt.map((r) => r.source_msg_id).sort(), errIds.map((id) => `${id}#stt`));

  // Retired once: the next tick changes nothing.
  const bytes = readFileSync(env.cursorPath);
  const calls = fake.calls.length;
  await c.pollOnce();
  assert.equal(fake.calls.length, calls);
  assert.ok(readFileSync(env.cursorPath).equals(bytes), "no state write when nothing changed");
});

test("row_gone: a thrown re-read or an unbuildable row is transient, never retired, no state write", async () => {
  const env = makeEnv();
  const fake = makeRunner();
  const c = makeConn(env, { runner: fake.runner });
  await c.pollOnce();
  const goneIds = await seedGonePending(env, c, 3);

  // (1) The late-path SELECTs throw on .get(): transient, nothing retires.
  const origPrepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql, ...rest) {
    const stmt = origPrepare.call(this, sql, ...rest);
    if (/WHERE m\.(Z_PK = \?|ZSTANZAID = \?)/.test(sql)) {
      return { get: () => { throw new Error("SQLITE_BUSY (stub)"); } };
    }
    return stmt;
  };
  let bytes = readFileSync(env.cursorPath);
  let mtime = statSync(env.cursorPath).mtimeMs;
  await new Promise((r) => setTimeout(r, 30));
  try {
    await c.pollOnce();
  } finally {
    DatabaseSync.prototype.prepare = origPrepare;
  }
  let st = readState(env);
  assert.deepEqual(st.voice_pending.map((e) => e.stanza), goneIds, "still pending, untouched");
  assert.ok(!(st.voice_failed || []).some((f) => f.reason === "row_gone"));
  assert.equal(statSync(env.cursorPath).mtimeMs, mtime, "state.json not rewritten");
  assert.ok(readFileSync(env.cursorPath).equals(bytes));

  // (2) A visible row whose rebuild throws is transient too.
  const cur = await c.readCursor();
  const visible = [{ zpk: 9, stanza: "voice-dm-1", first_seen: new Date().toISOString(), attempts: 0, reason: "deferred" }];
  await c.writeCursor({ ...cur, voice_pending: visible, voice_pending_n: 1 });
  c._buildLedgerRow = () => { throw new Error("build failure (stub)"); };
  bytes = readFileSync(env.cursorPath);
  mtime = statSync(env.cursorPath).mtimeMs;
  const calls = fake.calls.length;
  await new Promise((r) => setTimeout(r, 30));
  await c.pollOnce();
  st = readState(env);
  assert.deepEqual(st.voice_pending, visible);
  assert.equal(fake.calls.length, calls);
  assert.equal(statSync(env.cursorPath).mtimeMs, mtime, "state.json not rewritten");
  assert.ok(readFileSync(env.cursorPath).equals(bytes));
});

test("row_gone: a NULL-ZSTANZAID no_media row (id zpk:<Z_PK>) stays pending by Z_PK; retires only once the Z_PK row is deleted", async () => {
  // ZSTANZAID NULL -> _buildLedgerRow ids it "zpk:400"; its media is NULL.
  const sql = `INSERT INTO ZWAMEDIAITEM (Z_PK, ZMEDIALOCALPATH, ZMOVIEDURATION)
      VALUES (400, NULL, 2);
    INSERT INTO ZWAMESSAGE (Z_PK, ZSTANZAID, ZTEXT, ZISFROMME, ZMESSAGETYPE,
      ZGROUPEVENTTYPE, ZCHATSESSION, ZMESSAGEDATE, ZFROMJID, ZMEDIAITEM)
      VALUES (400, NULL, NULL, 0, 3, 0, 1, 770004000.0,
        '1234567890@s.whatsapp.net', 400);\n`;
  const env = makeEnv({ extraSql: sql });
  const fake = makeRunner();
  const c = makeConn(env, { runner: fake.runner });
  await c.pollOnce();
  assert.ok(byId(readLedger(env.ledgerPath))["zpk:400"], "parent ledgered under its zpk: id");
  const cur = await c.readCursor();
  const entry = { zpk: 400, stanza: "zpk:400", first_seen: new Date().toISOString(), attempts: 0, reason: "no_media" };
  await c.writeCursor({ ...cur, voice_pending: [entry], voice_pending_n: 1 });

  const calls = fake.calls.length;
  const bytes = readFileSync(env.cursorPath);
  const mtime = statSync(env.cursorPath).mtimeMs;
  await new Promise((r) => setTimeout(r, 30));
  for (let t = 0; t < 2; t += 1) {
    await c.pollOnce();
    const st = readState(env);
    assert.deepEqual(st.voice_pending, [entry], `tick ${t + 1}: still pending, untouched`);
    assert.ok(!(st.voice_failed || []).some((f) => f.stanza === "zpk:400"), `tick ${t + 1}: never row_gone`);
  }
  assert.equal(fake.calls.length, calls, "runner not called while media is NULL");
  assert.equal(statSync(env.cursorPath).mtimeMs, mtime, "state.json not rewritten");
  assert.ok(readFileSync(env.cursorPath).equals(bytes), "no state write when nothing changed");

  // The Z_PK row is deleted: now (and only now) it retires as row_gone.
  const db = new DatabaseSync(env.dbPath);
  db.prepare("DELETE FROM ZWAMESSAGE WHERE Z_PK = 400").run();
  db.close();
  await c.pollOnce();
  const st = readState(env);
  assert.deepEqual(st.voice_pending, []);
  assert.deepEqual(st.voice_failed.filter((f) => f.stanza === "zpk:400").map((f) => f.reason), ["row_gone"]);
  assert.equal(fake.calls.length, calls);
});

test("crash replay with > dedupTailLines rows after the voice row: no #stt, runner <= 1 per note, voice_done set", async () => {
  const TAIL = 20;
  const env = makeEnv();
  const fake1 = makeRunner();
  const c1 = makeConn(env, { runner: fake1.runner });
  c1.dedupTailLines = TAIL;
  c1.writeCursor = async () => {}; // crash between ledger append and state write
  await c1.pollOnce();
  assert.ok(!existsSync(env.cursorPath), "state write suppressed");
  const m = byId(readLedger(env.ledgerPath));
  for (const id of VOICE_IDS) assert.equal(m[id].raw_content.text_origin, "stt");

  // TAIL+5 new text rows land after the voice rows in the replayed page.
  const db = new DatabaseSync(env.dbPath);
  let sql = "";
  for (let k = 0; k < TAIL + 5; k += 1) {
    sql += `INSERT INTO ZWAMESSAGE (Z_PK, ZSTANZAID, ZTEXT, ZISFROMME, ZMESSAGETYPE,
      ZGROUPEVENTTYPE, ZCHATSESSION, ZMESSAGEDATE, ZFROMJID)
      VALUES (${500 + k}, 'later-text-${k}', 'later text ${k}', 0, 0, 0, 1,
        ${770005000 + k}.0, '1234567890@s.whatsapp.net');\n`;
  }
  db.exec(sql);
  db.close();

  const fake2 = makeRunner();
  const c2 = makeConn(env, { runner: fake2.runner });
  c2.dedupTailLines = TAIL;
  const r = await c2.pollOnce();
  assert.equal(r.errors, 0);
  assert.equal(r.appended, TAIL + 5, "only the new text rows append");
  const rows = readLedger(env.ledgerPath);
  assert.equal(rows.filter((x) => x.source_msg_id.endsWith("#stt")).length, 0, "zero #stt rows");
  for (const id of VOICE_IDS) {
    assert.ok(fake2.ids().filter((x) => x === id).length <= 1, `runner called at most once for ${id}`);
  }
  const merged = await c2.readCursor();
  for (const id of VOICE_IDS) assert.ok(merged.voice_done.includes(id), `${id} in voice_done`);
  assert.deepEqual(merged.voice_pending, []);
});

// --- V6: env_error / worker_crash / append_error, merge-on-write ------------

for (const code of ["env_error", "worker_crash"]) {
  test(`${code}: jobs stay pending with attempts unchanged; only the 72h TTL retires them`, async () => {
    const env = makeEnv();
    let clock = Date.parse("2026-09-01T00:00:00.000Z");
    const now = () => new Date(clock).toISOString();
    let calls = 0;
    const runner = async (jobs) => { calls += 1; return jobs.map((j) => ({ id: j.id, error: code })); };
    const c = makeConn(env, { runner, now });
    const r = await c.pollOnce();
    assert.equal(r.errors, 0);
    let st = readState(env);
    assert.equal(st.last_zpk, 12, "STT env failure never holds the cursor");
    assert.deepEqual(st.voice_pending.map((e) => [e.stanza, e.reason, e.attempts]).sort(),
      VOICE_IDS.map((id) => [id, code, 0]).sort());
    for (let k = 0; k < 4; k += 1) {
      clock += 3600_000;
      await c.pollOnce();
    }
    st = readState(env);
    assert.ok(calls >= 5, "retried on every tick");
    assert.deepEqual(st.voice_pending.map((e) => [e.stanza, e.reason, e.attempts]).sort(),
      VOICE_IDS.map((id) => [id, code, 0]).sort(), "no attempt consumed past VOICE_MAX_ATTEMPTS ticks");
    assert.deepEqual(st.voice_failed || [], []);
    const stateText = readFileSync(env.cursorPath, "utf8");
    assert.ok(!stateText.includes(env.tmpDir), "no audio paths in state");
    clock += 73 * 3600_000;
    await c.pollOnce();
    st = readState(env);
    assert.deepEqual(st.voice_pending, []);
    assert.deepEqual(st.voice_failed.map((e) => [e.stanza, e.reason]).sort(),
      VOICE_IDS.map((id) => [id, code]).sort(), "TTL retires them");
  });
}

test("append_error: a throwing late-path #stt append stays pending and consumes one attempt per tick", async () => {
  const env = makeEnv();
  writeFileSync(env.flagPath, "");
  const fake = makeRunner();
  const c = makeConn(env, { runner: fake.runner });
  await c.pollOnce(); // paused: both notes parked with 0 attempts
  unlinkSync(env.flagPath);
  const orig = c.appendLedgerRow.bind(c);
  c.appendLedgerRow = async (row) => {
    if (String(row.source_msg_id).endsWith("#stt")) throw new Error("disk full");
    return orig(row);
  };
  await c.pollOnce();
  let st = readState(env);
  assert.deepEqual(st.voice_pending.map((e) => [e.stanza, e.reason, e.attempts]).sort(),
    VOICE_IDS.map((id) => [id, "append_error", 1]).sort());
  assert.equal(readLedger(env.ledgerPath).filter((r) => r.source_msg_id.endsWith("#stt")).length, 0);
  await c.pollOnce();
  await c.pollOnce();
  st = readState(env);
  assert.deepEqual(st.voice_pending, [], "bounded by VOICE_MAX_ATTEMPTS");
  assert.deepEqual(st.voice_failed.map((e) => [e.stanza, e.reason]).sort(),
    VOICE_IDS.map((id) => [id, "append_error"]).sort());
});

test("readVoiceState drops pending entries whose stanza is in voice_done", async () => {
  const { readVoiceState } = await import("../lib/connectors/whatsapp.js");
  const vs = readVoiceState({
    voice_done: ["a", "b"],
    voice_pending: [
      { zpk: 1, stanza: "a", first_seen: "t", attempts: 1, reason: "stt_error" },
      { zpk: 3, stanza: "c", first_seen: "t", attempts: 0, reason: "paused" },
    ],
  });
  assert.deepEqual(vs.pending.map((e) => e.stanza), ["c"]);
  assert.deepEqual(vs.done, ["a", "b"]);
});

test("mergeVoiceState: per-stanza union; this writer's removals stay removed; done wins over pending", async () => {
  const { readVoiceState, mergeVoiceState } = await import("../lib/connectors/whatsapp.js");
  const P = (stanza, extra = {}) => ({ zpk: 1, stanza, first_seen: "2026-09-01T00:00:00.000Z", attempts: 0, reason: "paused", ...extra });
  const snap = { voice_pending: [P("keep"), P("mine-settled"), P("theirs-settled"), P("mine-bumped")], voice_done: ["old"] };
  const vs = readVoiceState(snap);
  // this writer: settles mine-settled (done), bumps mine-bumped, adds new-mine, fails f1.
  vs.pending = vs.pending.filter((e) => e.stanza !== "mine-settled" && e.stanza !== "mine-bumped");
  vs.pending.push(P("mine-bumped", { attempts: 1, reason: "stt_error" }), P("new-mine"), P("theirs-done", { attempts: 1, reason: "stt_error" }));
  vs.done.push("mine-settled");
  vs.failed.push({ zpk: 9, stanza: "f1", reason: "quality_gate", failed_at: "2026-09-01T00:00:02.000Z" });
  vs.changed = true;
  // the other writer meanwhile: settled theirs-settled + theirs-done, added new-theirs, failed f2.
  const fresh = {
    voice_pending: [P("keep"), P("mine-settled"), P("mine-bumped"), P("new-theirs")],
    voice_done: ["old", "theirs-settled", "theirs-done"],
    voice_failed: [{ zpk: 8, stanza: "f2", reason: "too_long", failed_at: "2026-09-01T00:00:01.000Z" }],
  };
  const m = mergeVoiceState(fresh, vs);
  assert.deepEqual(m.done, ["old", "theirs-settled", "theirs-done", "mine-settled"]);
  assert.deepEqual(m.pending.map((e) => e.stanza).sort(), ["keep", "mine-bumped", "new-mine", "new-theirs"]);
  assert.equal(m.pending.find((e) => e.stanza === "mine-bumped").attempts, 1);
  assert.deepEqual(m.failed.map((f) => f.stanza), ["f2", "f1"]);
  for (const e of m.pending) assert.ok(!m.done.includes(e.stanza));
});

// Voice rows 13..15 inserted AFTER the first (paused) poll, so the racing
// poll transcribes them in-band while voice-dm-1/-2 wait in voice_pending.
function insertRaceRows(env) {
  const db = new DatabaseSync(env.dbPath);
  let sql = "";
  [[13, "voice-dm-3"], [14, "voice-dm-4"], [15, "voice-dm-5"]].forEach(([pk, sid], k) => {
    sql += voiceNoteSql(20 + k, sid, { media: `Media/${sid}.opus`, date: 770000700 + k })
      .replace(`VALUES (${20 + k}, '${sid}'`, `VALUES (${pk}, '${sid}'`);
  });
  db.exec(sql);
  db.close();
}
// in-band: dm-3 ok, dm-4 quality_gate (terminal), dm-5 no line (no_result).
const RACE_INBAND = (j) => (j.id === "voice-dm-3" ? { id: j.id, text: "hello three", compression_ratio: 1.1 }
  : j.id === "voice-dm-4" ? { id: j.id, text: "", compression_ratio: 1.1 } : null);

async function raceSetup() {
  const env = makeEnv({ extraMedia: ["voice-dm-3", "voice-dm-4", "voice-dm-5"] });
  writeFileSync(env.flagPath, "");
  await makeConn(env, { runner: async () => { throw new Error("paused"); } }).pollOnce();
  unlinkSync(env.flagPath);
  insertRaceRows(env);
  const st = readState(env);
  assert.deepEqual(st.voice_pending.map((e) => e.stanza).sort(), [...VOICE_IDS].sort());
  return env;
}

function assertRaceMerged(env, merged) {
  for (const id of ["voice-dm-1", "voice-dm-2", "voice-dm-3"]) {
    assert.ok(merged.voice_done.includes(id), `${id} done survives`);
  }
  assert.deepEqual(merged.voice_pending.map((e) => [e.stanza, e.reason, e.attempts]),
    [["voice-dm-5", "no_result", 1]], "only the poll's own no_result stays pending");
  assert.deepEqual(merged.voice_failed.map((e) => [e.stanza, e.reason]), [["voice-dm-4", "quality_gate"]]);
  for (const e of merged.voice_pending) assert.ok(!merged.voice_done.includes(e.stanza));
  assert.equal(merged.voice_pending_n, merged.voice_pending.length);
  assert.equal(readState(env).last_zpk, 15);
}

test("interleave: a backfill voice write between a poll's cursor read and write loses nothing", async () => {
  const env = await raceSetup();
  const backfiller = makeConn(env, {
    runner: async (jobs) => jobs.map((j) => ({ id: j.id, text: `bf ${j.id}`, compression_ratio: 1.1 })),
  });
  let n = 0;
  let summary = null;
  const pollRunner = async (jobs) => {
    n += 1;
    if (n === 1) {
      // The poll already read its cursor; the backfill runs to completion
      // (read + write) before the poll settles and writes.
      summary = await backfiller.backfillVoice();
      return jobs.map(RACE_INBAND).filter(Boolean);
    }
    return []; // late path: voice-dm-1/-2 come back empty (no_result)
  };
  const poller = makeConn(env, { runner: pollRunner });
  await poller.pollOnce();
  assert.equal(summary.transcribed, 2, "backfill transcribed voice-dm-1/-2");
  assertRaceMerged(env, await poller.readCursor());
});

test("interleave: a poll write between a backfill's cursor read and write loses nothing", async () => {
  const env = await raceSetup();
  let pollN = 0;
  const poller = makeConn(env, {
    runner: async (jobs) => {
      pollN += 1;
      return pollN === 1 ? jobs.map(RACE_INBAND).filter(Boolean) : [];
    },
  });
  const backfiller = makeConn(env, {
    runner: async (jobs) => {
      // The backfill already read its cursor; a full poll (read + write)
      // lands before the backfill settles and writes.
      await poller.pollOnce();
      return jobs.map((j) => ({ id: j.id, text: `bf ${j.id}`, compression_ratio: 1.1 }));
    },
  });
  const summary = await backfiller.backfillVoice();
  assert.equal(summary.transcribed, 2);
  assertRaceMerged(env, await backfiller.readCursor());
});

// --- V8: one pause flag for worker + connector; failed wins over pending ----

// The child environment is built from scratch below and never inherits this
// process's pause variables, so each case decides alone which one the CLI sees:
// setFlagEnv sets only WHATSAPP_VOICE_PAUSE_FLAG, setGamepauseEnv sets only
// GAMEPAUSE_FLAG (to a path that does not exist, so nothing is paused).
async function runBackfillCliEchoFlag(name, { setFlagEnv, setGamepauseEnv = false }) {
  const cliRoot = join(ROOT, name);
  const env = { ...makeEnv() };
  env.ledgerPath = join(cliRoot, "storage", "sources", "whatsapp.jsonl");
  env.cursorPath = join(cliRoot, "connectors", "whatsapp", "state.json");
  mkdirSync(join(cliRoot, "storage", "sources"), { recursive: true });
  await seedBackfillLedger(env);
  const flagsFile = join(cliRoot, "worker-flags.jsonl");
  const fakeScript = join(cliRoot, "fake-stt-flag.mjs");
  writeFileSync(fakeScript, `
import { appendFileSync } from "node:fs";
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { buf += c; });
process.stdin.on("end", () => {
  const jobs = JSON.parse(buf);
  appendFileSync(${JSON.stringify(flagsFile)}, JSON.stringify(process.env.GAMEPAUSE_FLAG ?? null) + "\\n");
  for (const j of jobs) process.stdout.write(JSON.stringify({ id: j.id, text: "hello " + j.id,
    language: "en", avg_logprob: -0.1, no_speech_prob: 0.01, compression_ratio: 1.1, duration_s: 3 }) + "\\n");
});
`);
  const childEnv = {
    PATH: process.env.PATH,
    HOME: cliRoot,
    MEMORY_ROOT: cliRoot,
    POLICY_BASE_DIR: join(cliRoot, "policy"),
    STORAGE_BASE_DIR: join(cliRoot, "storage"),
    LEDGERS_BASE_DIR: join(cliRoot, "ledgers"),
    CONNECTORS_BASE_DIR: join(cliRoot, "connectors"),
    WHATSAPP_STT_PYTHON: process.execPath,
    WHATSAPP_STT_SCRIPT: fakeScript,
    WHATSAPP_VOICE_MEDIA_ROOT: env.mediaRoot,
    WHATSAPP_VOICE_TMP_DIR: env.tmpDir,
  };
  // Hermetic: an ambient pause variable of the test runner never reaches the CLI.
  delete childEnv.GAMEPAUSE_FLAG;
  delete childEnv.WHATSAPP_VOICE_PAUSE_FLAG;
  const ambientFlag = join(cliRoot, "ambient-pause.flag");
  if (setFlagEnv) childEnv.WHATSAPP_VOICE_PAUSE_FLAG = env.flagPath;
  if (setGamepauseEnv) childEnv.GAMEPAUSE_FLAG = ambientFlag;
  const res = spawnSync(process.execPath, [WHATSAPP_JS, "--backfill-voice"], {
    encoding: "utf8", timeout: 60_000, env: childEnv,
  });
  assert.equal(res.status, 0, `stderr=${res.stderr}`);
  const flags = readFileSync(flagsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { env, cliRoot, flags, ambientFlag, summary: JSON.parse(res.stdout.trim()) };
}

test("CLI --backfill-voice V8: WHATSAPP_VOICE_PAUSE_FLAG reaches the worker as GAMEPAUSE_FLAG", async () => {
  const { env, flags, summary } = await runBackfillCliEchoFlag("cli-flag-env", { setFlagEnv: true });
  assert.ok(flags.length >= 1);
  assert.ok(flags.every((f) => f === env.flagPath), JSON.stringify(flags));
  assert.equal(summary.transcribed, BACKFILL_EXPECTED.transcribed);
});

test("CLI --backfill-voice V8: with neither pause variable set the worker gets no GAMEPAUSE_FLAG", async () => {
  const { flags, summary } = await runBackfillCliEchoFlag("cli-flag-default", { setFlagEnv: false });
  assert.ok(flags.length >= 1);
  assert.ok(flags.every((f) => f === null), JSON.stringify(flags));
  assert.equal(summary.transcribed, BACKFILL_EXPECTED.transcribed);
});

test("CLI --backfill-voice V8: a lone GAMEPAUSE_FLAG reaches the worker unchanged", async () => {
  const { ambientFlag, flags, summary } = await runBackfillCliEchoFlag("cli-flag-ambient", {
    setFlagEnv: false,
    setGamepauseEnv: true,
  });
  assert.ok(flags.length >= 1);
  assert.ok(flags.every((f) => f === ambientFlag), JSON.stringify(flags));
  assert.equal(summary.transcribed, BACKFILL_EXPECTED.transcribed);
});

test("mergeVoiceState V8: a stanza in the merged failed list is dropped from pending", async () => {
  const { readVoiceState, mergeVoiceState } = await import("../lib/connectors/whatsapp.js");
  const P = (stanza, extra = {}) => ({ zpk: 1, stanza, first_seen: "2026-09-01T00:00:00.000Z", attempts: 1, reason: "stt_error", ...extra });
  const vs = readVoiceState({ voice_pending: [P("both"), P("keep")] });
  vs.pending = vs.pending.map((e) => (e.stanza === "both" ? { ...e, attempts: 2 } : e)); // this writer bumped it
  vs.changed = true;
  // the other writer meanwhile failed "both" terminally.
  const fresh = {
    voice_pending: [P("keep")],
    voice_failed: [{ zpk: 1, stanza: "both", reason: "stt_error", failed_at: "2026-09-01T00:00:03.000Z" }],
  };
  const m = mergeVoiceState(fresh, vs);
  assert.deepEqual(m.pending.map((e) => e.stanza), ["keep"]);
  assert.deepEqual(m.failed.map((f) => f.stanza), ["both"]);
  const failed = new Set(m.failed.map((f) => f.stanza));
  for (const e of m.pending) assert.ok(!failed.has(e.stanza));
});
