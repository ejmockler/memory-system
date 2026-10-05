// queryd.test.mjs — Q1 resident query daemon: protocol, lifecycle, lease,
// bounded fair queue, deadlines, generation swap, and the daemon-vs-direct
// equivalence gate.
//
// RED-FIRST NOTE: queryd is a NEW component — there is no pre-existing
// guard-free daemon surface to run the (b) lease / (d) deadline / (e) busy /
// (h) malformed-frame assertions red against, and stubbing a guard-free
// daemon just to watch it fail would test the stub, not the system. The
// meaningful red baseline is the absence of the component itself (the
// pre-daemon world where every session pays its own index load, measured in
// the parent node). (a) equivalence and (f) generation swap are new behavior
// by the node spec — no red applicable.
//
// Discipline (matches test/recall/index-wal.test.mjs):
//   - mkdtempSync rooted in tmpdir (SHORT prefix: unix socket paths cap at
//     ~104 bytes on macOS); MEMORY_ROOT + POLICY/STORAGE/LEDGERS/TELEMETRY
//     base dirs overwritten BEFORE any dynamic import. The production
//     indices dir and live daemons are NEVER touched or signaled.
//   - fixtures only; a final assertion pins that ledgers/memory.jsonl was
//     never created inside the temp tree.
//   - small synthetic dims=8 unit vectors; per-test model versions.
//   - node:test + node:assert/strict; _resetCaches() between tests.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Hermeticity: stake tmp dirs + overwrite env BEFORE any dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "q1-"));
const MEMORY_ROOT = join(TMP_ROOT, "m");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");
process.env.TELEMETRY_BASE_DIR = join(MEMORY_ROOT, "telemetry");
// High thresholds: nothing auto-flushes; index publication is explicit here.
process.env.INDEX_SAVE_BATCH = "1000";
process.env.INDEX_SAVE_MAX_AGE_S = "3600";

mkdirSync(process.env.POLICY_BASE_DIR, { recursive: true, mode: 0o700 });
mkdirSync(process.env.STORAGE_BASE_DIR, { recursive: true, mode: 0o700 });
mkdirSync(process.env.LEDGERS_BASE_DIR, { recursive: true, mode: 0o700 });
mkdirSync(join(MEMORY_ROOT, "indices"), { recursive: true, mode: 0o700 });

process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// Dynamic import AFTER env override.
const { loadIndices, saveIndices, _resetCaches } = await import(
  "../../lib/recall/index-cache.js"
);
const { Bm25Index } = await import("../../lib/recall/bm25-index.js");
const { HnswIndex } = await import("../../lib/recall/hnsw-index.js");
const {
  Queryd,
  querydPaths,
  queryOnce,
} = await import("../../daemon/queryd.js");
const proto = await import("../../daemon/queryd-protocol.js");

const QUERYD_PATH = join(import.meta.dirname, "..", "..", "daemon", "queryd.js");
const { dir: QUERYD_DIR, socketPath: SOCKET_PATH, lockPath: LOCK_PATH } =
  querydPaths();

// macOS sun_path cap (~104 bytes). Fail loudly rather than mysteriously.
assert.ok(
  Buffer.byteLength(SOCKET_PATH) < 100,
  `socket path too long for AF_UNIX: ${SOCKET_PATH}`,
);

// ---------------------------------------------------------------------------
// Fixtures (same shapes as test/recall/index-wal.test.mjs).
// ---------------------------------------------------------------------------
const DIMS = 8;

function unitVec(seed) {
  const v = [];
  let x = (seed + 1) * 2654435761;
  for (let i = 0; i < DIMS; i++) {
    x = (x * 1103515245 + 12345) % 2147483647;
    v.push((x % 1000) / 1000 + 0.01);
  }
  const norm = Math.sqrt(v.reduce((s, a) => s + a * a, 0));
  return v.map((a) => a / norm);
}

function bm25EntryFor(id, token, extra = "") {
  return {
    memory_id: id,
    kind: "fact",
    content: `synthetic fact ${id} ${token} ${extra}`.trim(),
    ts: "2026-07-14T00:00:00Z",
    entities: [],
    valence: null,
    consent_basis: "first_party",
  };
}

// Seed a dims=8 generation with `n` facts and publish it (saveIndices ->
// publishGeneration). Returns the fact ids.
function seedGeneration(modelVersion, { n = 8, token = "tok", seedBase = 0 } = {}) {
  const bm25 = new Bm25Index();
  const hnsw = new HnswIndex({
    dims: DIMS,
    embedding_model_version: modelVersion,
    maxElements: 1024,
  });
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = `mem_${modelVersion}_${i}`;
    const entry = bm25EntryFor(id, `${token}${i}`, `shared${i % 3}`);
    bm25.add(entry);
    hnsw.add(id, unitVec(seedBase + i));
    ids.push(id);
  }
  saveIndices(modelVersion, { bm25, hnsw });
  _resetCaches();
  return ids;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// Minimal test client (Q2 owns the production client; this is test-local).
// ---------------------------------------------------------------------------
class TestClient {
  constructor(socketPath = SOCKET_PATH) {
    this.sock = netConnect(socketPath);
    this.decoder = new proto.FrameDecoder({
      maxFrameBytes: proto.MAX_OUTBOUND_FRAME_BYTES,
    });
    this.pending = new Map();
    this.inbox = [];
    this.inboxWaiters = [];
    this.nextId = 1;
    this.closed = new Promise((res) => this.sock.on("close", () => res()));
    this.connected = new Promise((res, rej) => {
      this.sock.once("connect", res);
      this.sock.once("error", rej);
    });
    this.sock.on("error", () => {});
    this.sock.on("data", (chunk) => {
      const { frames, error } = this.decoder.push(chunk);
      for (const f of frames) this._deliver(f);
      if (error != null) this._deliver({ _decode_error: error });
    });
  }

  _deliver(frame) {
    if (frame != null && frame.id != null && this.pending.has(frame.id)) {
      const resolve = this.pending.get(frame.id);
      this.pending.delete(frame.id);
      resolve(frame);
      return;
    }
    const w = this.inboxWaiters.shift();
    if (w != null) w(frame);
    else this.inbox.push(frame);
  }

  nextInbox(timeoutMs = 5000) {
    if (this.inbox.length > 0) return Promise.resolve(this.inbox.shift());
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("nextInbox timeout")), timeoutMs);
      this.inboxWaiters.push((f) => {
        clearTimeout(t);
        res(f);
      });
    });
  }

  request(fields, { timeoutMs = 10000 } = {}) {
    const id = `t-${this.nextId++}`;
    const p = new Promise((res, rej) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`request ${id} timed out`));
      }, timeoutMs);
      this.pending.set(id, (f) => {
        clearTimeout(t);
        res(f);
      });
    });
    this.sock.write(
      proto.encodeFrame({
        protocol_version: proto.PROTOCOL_VERSION,
        id,
        ...fields,
      }),
    );
    return p;
  }

  sendRaw(buf) {
    this.sock.write(buf);
  }

  close() {
    this.sock.destroy();
  }
}

// ---------------------------------------------------------------------------
// Protocol unit tests
// ---------------------------------------------------------------------------
test("protocol: frames round-trip across chunk boundaries; caps enforced at the prefix", () => {
  const dec = new proto.FrameDecoder({ maxFrameBytes: 1024 });
  const f1 = proto.encodeFrame({ a: 1 });
  const f2 = proto.encodeFrame({ b: "two" });
  const joined = Buffer.concat([f1, f2]);
  // Deliver byte-by-byte to exercise incremental reassembly.
  const got = [];
  for (let i = 0; i < joined.length; i++) {
    const { frames, error } = dec.push(joined.subarray(i, i + 1));
    assert.equal(error, null);
    got.push(...frames);
  }
  assert.deepEqual(got, [{ a: 1 }, { b: "two" }]);

  // Oversized DECLARED length errors as soon as the prefix is readable —
  // before any body arrives.
  const dec2 = new proto.FrameDecoder({ maxFrameBytes: 1024 });
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(4096, 0);
  const r2 = dec2.push(prefix);
  assert.equal(r2.error.code, "bad_frame");
  assert.match(r2.error.message, /exceeds cap/);
  // Decoder is dead after an error.
  assert.equal(dec2.push(Buffer.from("more")).error.code, "bad_frame");

  // Zero-length frame is malformed.
  const dec3 = new proto.FrameDecoder({ maxFrameBytes: 1024 });
  const zero = Buffer.alloc(4);
  const r3 = dec3.push(zero);
  assert.equal(r3.error.code, "bad_frame");

  // Malformed JSON body is one structured error.
  const dec4 = new proto.FrameDecoder({ maxFrameBytes: 1024 });
  const badBody = Buffer.from("npmpm", "utf8");
  const badFrame = Buffer.alloc(4 + badBody.length);
  badFrame.writeUInt32BE(badBody.length, 0);
  badBody.copy(badFrame, 4);
  const r4 = dec4.push(badFrame);
  assert.equal(r4.error.code, "bad_frame");

  // encodeFrame refuses payloads over the cap.
  assert.throws(
    () => proto.encodeFrame({ big: "x".repeat(2048) }, { maxBytes: 1024 }),
    (e) => e.code === "frame_too_large",
  );

  // Deadline clamp: default on absent/invalid, cap at MAX_DEADLINE_MS.
  assert.equal(proto.clampDeadlineMs(undefined), proto.DEFAULT_DEADLINE_MS);
  assert.equal(proto.clampDeadlineMs(-5), proto.DEFAULT_DEADLINE_MS);
  assert.equal(proto.clampDeadlineMs(1), 1);
  assert.equal(proto.clampDeadlineMs(10 ** 9), proto.MAX_DEADLINE_MS);
});

// ---------------------------------------------------------------------------
// Child-process daemon: (a) equivalence, (i) permissions, (j) vector_fetch,
// (k) --status probe, (b) second-instance lease refusal, (g) SIGTERM drain.
// ---------------------------------------------------------------------------
test("child daemon: equivalence gate, permissions, lease, --status, SIGTERM", async (t) => {
  const MV = "q1-child-mv";
  const ids = seedGeneration(MV, { n: 12, token: "childtok", seedBase: 40 });

  // Direct (in-process) baseline: a FRESH manifest-gated load from disk —
  // the same deserialize path the child daemon takes.
  const direct = loadIndices(MV);
  const QUERY = "synthetic fact childtok3 shared0";
  const qvec = unitVec(99);
  const directBm25 = direct.bm25.search(QUERY, 10);
  const directHnsw = direct.hnsw.search(qvec, 5);
  assert.ok(directBm25.length > 0, "fixture sanity: bm25 baseline non-empty");
  assert.ok(directHnsw.length > 0, "fixture sanity: hnsw baseline non-empty");

  const child = spawn(process.execPath, [QUERYD_PATH, `--models=${MV}`], {
    env: { ...process.env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let childStderr = "";
  child.stderr.on("data", (d) => {
    childStderr += String(d);
  });
  const childExit = new Promise((res) =>
    child.once("exit", (code, sig) => res({ code, sig })),
  );

  try {
    // Wait for READY (status is answered in every state).
    let status = null;
    const deadline = Date.now() + 15000;
    for (;;) {
      try {
        const resp = await queryOnce(SOCKET_PATH, { type: "status" });
        if (resp.ok === true && resp.state === "ready") {
          status = resp;
          break;
        }
      } catch {
        // socket not up yet
      }
      assert.ok(
        Date.now() < deadline,
        `child daemon never became ready; stderr:\n${childStderr}`,
      );
      await sleep(100);
    }

    // (k) status shape: state, per-model generation + sizes, uptime, rss.
    assert.equal(status.state, "ready");
    assert.equal(status.models.length, 1);
    assert.equal(status.models[0].model_version, MV);
    assert.equal(status.models[0].generation, 0);
    assert.equal(status.models[0].bm25_size, 12);
    assert.equal(status.models[0].hnsw_size, 12);
    assert.equal(status.models[0].degraded, false);
    assert.ok(status.uptime_s >= 0);
    assert.ok(status.rss_bytes > 0);
    assert.equal(status.protocol_version, proto.PROTOCOL_VERSION);

    // (i) permissions: 0700 dir, 0600 socket.
    assert.equal(statSync(QUERYD_DIR).mode & 0o777, 0o700, "queryd dir 0700");
    assert.equal(statSync(SOCKET_PATH).mode & 0o777, 0o600, "socket 0600");

    // (a) EQUIVALENCE GATE: daemon results deep-equal direct loadIndices
    // results (ids + scores + ranks) over the same fixture generation.
    const bmResp = await queryOnce(SOCKET_PATH, {
      type: "bm25_search",
      model_version: MV,
      query_text: QUERY,
      k: 10,
    });
    assert.equal(bmResp.ok, true, JSON.stringify(bmResp));
    assert.equal(bmResp.generation, 0);
    assert.deepEqual(bmResp.results, directBm25);

    const hnResp = await queryOnce(SOCKET_PATH, {
      type: "hnsw_search",
      model_version: MV,
      vector: qvec,
      k: 5,
    });
    assert.equal(hnResp.ok, true, JSON.stringify(hnResp));
    assert.deepEqual(hnResp.results, directHnsw);

    // (j) vector_fetch: index-resident vectors for known ids; structured
    // nulls for unknown ids.
    const wanted = [ids[0], ids[7], "q1-missing-id"];
    const vfResp = await queryOnce(SOCKET_PATH, {
      type: "vector_fetch",
      model_version: MV,
      ids: wanted,
    });
    assert.equal(vfResp.ok, true, JSON.stringify(vfResp));
    assert.equal(vfResp.vectors.length, 3);
    assert.equal(vfResp.vectors[0].id, ids[0]);
    assert.deepEqual(vfResp.vectors[0].vector, direct.hnsw.getVectorByMemoryId(ids[0]));
    assert.deepEqual(vfResp.vectors[1].vector, direct.hnsw.getVectorByMemoryId(ids[7]));
    assert.equal(vfResp.vectors[2].id, "q1-missing-id");
    assert.equal(vfResp.vectors[2].vector, null);

    // vector_fetch batch cap -> structured bad_request.
    const tooMany = await queryOnce(SOCKET_PATH, {
      type: "vector_fetch",
      model_version: MV,
      ids: Array.from({ length: proto.VECTOR_FETCH_MAX_IDS + 1 }, (_, i) => `x${i}`),
    });
    assert.equal(tooMany.ok, false);
    assert.equal(tooMany.error.code, "bad_request");

    // Unknown model_version -> structured bad_request (never a crash).
    const badMv = await queryOnce(SOCKET_PATH, {
      type: "bm25_search",
      model_version: "no-such-model",
      query_text: "x",
      k: 5,
    });
    assert.equal(badMv.ok, false);
    assert.equal(badMv.error.code, "bad_request");

    // (k) --status CLI probe against the live daemon: exit 0, JSON on stdout.
    const probe = spawnSync(process.execPath, [QUERYD_PATH, "--status"], {
      env: { ...process.env },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(probe.status, 0, `--status probe failed: ${probe.stderr}`);
    const probed = JSON.parse(probe.stdout);
    assert.equal(probed.state, "ready");
    assert.equal(probed.models[0].bm25_size, 12);

    // (b) second instance against the same MEMORY_ROOT refuses to start
    // while the first holds queryd.lock: nonzero exit + structured stderr.
    const second = spawnSync(
      process.execPath,
      [QUERYD_PATH, `--models=${MV}`],
      { env: { ...process.env }, encoding: "utf8", timeout: 15000 },
    );
    assert.notEqual(second.status, 0, "second instance must exit nonzero");
    const errLine = second.stderr
      .split("\n")
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .find((o) => o != null && o.event === "start_failed");
    assert.ok(errLine, `no structured start_failed line in: ${second.stderr}`);
    assert.equal(errLine.code, "queryd_lock_held");
    // The first daemon is untouched.
    const still = await queryOnce(SOCKET_PATH, { type: "status" });
    assert.equal(still.ok, true);

    // (g) SIGTERM: drain, close+unlink socket, release lease, exit 0.
    child.kill("SIGTERM");
    const { code } = await childExit;
    assert.equal(code, 0, `SIGTERM exit code ${code}; stderr:\n${childStderr}`);
    assert.ok(!existsSync(SOCKET_PATH), "socket unlinked on shutdown");
    assert.ok(!existsSync(LOCK_PATH), "queryd.lock released on shutdown");

    // (k) --status against the dead socket: nonzero.
    const deadProbe = spawnSync(process.execPath, [QUERYD_PATH, "--status"], {
      env: { ...process.env },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.notEqual(deadProbe.status, 0, "--status must fail on a dead socket");
  } finally {
    if (child.exitCode == null) child.kill("SIGKILL");
    _resetCaches();
  }
});

// ---------------------------------------------------------------------------
// (c) LOADING: queries rejected immediately during a slow load
// ---------------------------------------------------------------------------
test("(c) queries during a slow load get an immediate loading error, never queued", async () => {
  const MV = "q1-loading-mv";
  seedGeneration(MV, { n: 3, token: "loadtok" });
  const daemon = new Queryd({ modelVersions: [MV], watchIntervalMs: 60000 });
  const gate = deferred();
  daemon._setSlowLoadHook(() => gate.promise);
  await daemon.start();
  const client = new TestClient();
  try {
    await client.connected;
    // Handshake: the daemon sends a hello frame first, carrying the state.
    const hello = await client.nextInbox();
    assert.equal(hello.type, "hello");
    assert.equal(hello.protocol_version, proto.PROTOCOL_VERSION);
    assert.equal(hello.state, "loading");

    // The load is stalled on the hook — this response arriving proves the
    // request was answered immediately rather than queued across states.
    const resp = await client.request({
      type: "bm25_search",
      model_version: MV,
      query_text: "loadtok0",
      k: 5,
    });
    assert.equal(resp.ok, false);
    assert.equal(resp.error.code, "loading");
    assert.equal(resp.state, "loading");

    gate.resolve();
    await daemon.ready;
    assert.equal(daemon.state, "ready");

    // Same connection serves normally after the load.
    const resp2 = await client.request({
      type: "bm25_search",
      model_version: MV,
      query_text: "synthetic fact loadtok0",
      k: 5,
    });
    assert.equal(resp2.ok, true);
    assert.ok(resp2.results.length > 0);
  } finally {
    client.close();
    await daemon.stop();
    _resetCaches();
  }
});

// ---------------------------------------------------------------------------
// (d) deadline enforcement; connection stays usable after a timeout
// ---------------------------------------------------------------------------
test("(d) deadline_ms=1 against a stalled handler returns timeout; connection stays usable", async () => {
  const MV = "q1-deadline-mv";
  seedGeneration(MV, { n: 2, token: "dltok" });
  const daemon = new Queryd({ modelVersions: [MV], watchIntervalMs: 60000 });
  await daemon.start();
  await daemon.ready;
  const client = new TestClient();
  try {
    await client.connected;
    daemon._setStallHook(() => sleep(120));
    const resp = await client.request({
      type: "bm25_search",
      model_version: MV,
      query_text: "dltok0",
      k: 5,
      deadline_ms: 1,
    });
    assert.equal(resp.ok, false);
    assert.equal(resp.error.code, "timeout");

    // The SAME connection must serve a subsequent request.
    daemon._setStallHook(null);
    const resp2 = await client.request({
      type: "bm25_search",
      model_version: MV,
      query_text: "synthetic fact dltok1",
      k: 5,
    });
    assert.equal(resp2.ok, true);
    assert.ok(resp2.results.length > 0);
  } finally {
    client.close();
    await daemon.stop();
    _resetCaches();
  }
});

// ---------------------------------------------------------------------------
// (e) bounded fair queue: busy on overflow (global + per-connection caps)
// ---------------------------------------------------------------------------
test("(e) queue overflow returns an immediate structured busy error", async () => {
  const MV = "q1-busy-mv";
  seedGeneration(MV, { n: 2, token: "busytok" });
  const daemon = new Queryd({
    modelVersions: [MV],
    watchIntervalMs: 60000,
    maxInFlight: 1,
    maxQueued: 2,
    maxQueuedPerConn: 2,
  });
  await daemon.start();
  await daemon.ready;
  const a = new TestClient();
  const b = new TestClient();
  try {
    await a.connected;
    await b.connected;
    const gates = [];
    daemon._setStallHook(() => new Promise((r) => gates.push(r)));

    const req = (client) =>
      client.request({
        type: "bm25_search",
        model_version: MV,
        query_text: "busytok0",
        k: 5,
        deadline_ms: 30000,
      });

    const p1 = req(a); // dispatched -> in-flight (stalled)
    const p2 = req(a); // queued (1/2 global, 1/2 per-conn)
    const p3 = req(a); // queued (2/2 global, 2/2 per-conn)
    // Per-connection cap exceeded -> immediate busy (stall gates still held).
    const r4 = await req(a);
    assert.equal(r4.ok, false);
    assert.equal(r4.error.code, "busy");
    assert.match(r4.error.message, /per-connection/);

    // Global queue cap exceeded from ANOTHER connection -> immediate busy.
    const r5 = await req(b);
    assert.equal(r5.ok, false);
    assert.equal(r5.error.code, "busy");
    assert.match(r5.error.message, /queue cap/);

    // Release: clear the hook, then unblock the stalled in-flight request;
    // the queued requests drain and succeed.
    daemon._setStallHook(null);
    for (const g of gates) g();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.equal(r3.ok, true);
  } finally {
    a.close();
    b.close();
    await daemon.stop();
    _resetCaches();
  }
});

// ---------------------------------------------------------------------------
// (f) generation swap: new content within the stat window; in-flight requests
//     complete on the OLD generation's objects
// ---------------------------------------------------------------------------
test("(f) publishGeneration while running: swap within the stat window, in-flight on old ref", async () => {
  const MV = "q1-swap-mv";
  seedGeneration(MV, { n: 4, token: "oldtok", seedBase: 10 });
  const daemon = new Queryd({ modelVersions: [MV], watchIntervalMs: 150 });
  await daemon.start();
  await daemon.ready;
  const client = new TestClient();
  try {
    await client.connected;

    const before = await client.request({
      type: "bm25_search",
      model_version: MV,
      query_text: "oldtok1",
      k: 10,
    });
    assert.equal(before.ok, true);
    assert.equal(before.generation, 0);
    assert.ok(before.results.length > 0, "old generation content served");

    // Stall exactly ONE request in-flight across the swap.
    const gate = deferred();
    let armed = gate.promise;
    daemon._setStallHook(() => {
      const p = armed;
      armed = null;
      return p ?? Promise.resolve();
    });
    const inFlight = client.request({
      type: "bm25_search",
      model_version: MV,
      query_text: "oldtok2",
      k: 10,
      deadline_ms: 30000,
    });
    await sleep(20); // let it dispatch and capture the gen-0 entry ref

    // Publish generation 1 with DIFFERENT content (newtok, no oldtok).
    const bm25B = new Bm25Index();
    const hnswB = new HnswIndex({
      dims: DIMS,
      embedding_model_version: MV,
      maxElements: 1024,
    });
    for (let i = 0; i < 3; i++) {
      const id = `mem_${MV}_new_${i}`;
      bm25B.add(bm25EntryFor(id, `newtok${i}`));
      hnswB.add(id, unitVec(70 + i));
    }
    saveIndices(MV, { bm25: bm25B, hnsw: hnswB });

    // The daemon picks up the new generation within the stat window.
    let swapped = null;
    const deadline = Date.now() + 10000;
    for (;;) {
      const st = await client.request({ type: "status" });
      if (st.models[0].generation === 1 && st.state === "ready") {
        swapped = st;
        break;
      }
      assert.ok(Date.now() < deadline, "daemon never swapped to generation 1");
      await sleep(50);
    }
    assert.equal(swapped.models[0].bm25_size, 3);

    // New requests serve the NEW generation's content.
    const afterNew = await client.request({
      type: "bm25_search",
      model_version: MV,
      query_text: "newtok1",
      k: 10,
    });
    assert.equal(afterNew.ok, true);
    assert.equal(afterNew.generation, 1);
    assert.ok(afterNew.results.length > 0, "new generation content served");
    const afterOld = await client.request({
      type: "bm25_search",
      model_version: MV,
      query_text: "oldtok2",
      k: 10,
    });
    assert.equal(afterOld.ok, true);
    assert.equal(
      afterOld.results.length,
      0,
      "old content gone from the new generation",
    );

    // Release the stalled request: it completes on the OLD objects (old
    // generation, old content) — the swap never retargets in-flight work.
    gate.resolve();
    const inFlightResp = await inFlight;
    assert.equal(inFlightResp.ok, true);
    assert.equal(inFlightResp.generation, 0);
    assert.ok(
      inFlightResp.results.length > 0,
      "in-flight request completed on the old generation's content",
    );
  } finally {
    daemon._setStallHook(null);
    client.close();
    await daemon.stop();
    _resetCaches();
  }
});

// ---------------------------------------------------------------------------
// (h) malformed / oversized frames: one structured error + close; no crash
// ---------------------------------------------------------------------------
test("(h) malformed and oversized frames get one structured error then close; daemon survives", async () => {
  const MV = "q1-frames-mv";
  seedGeneration(MV, { n: 2, token: "frtok" });
  const daemon = new Queryd({ modelVersions: [MV], watchIntervalMs: 60000 });
  await daemon.start();
  await daemon.ready;
  try {
    // Malformed JSON body.
    const c1 = new TestClient();
    await c1.connected;
    assert.equal((await c1.nextInbox()).type, "hello");
    const badBody = Buffer.from("npmpm", "utf8");
    const badFrame = Buffer.alloc(4 + badBody.length);
    badFrame.writeUInt32BE(badBody.length, 0);
    badBody.copy(badFrame, 4);
    c1.sendRaw(badFrame);
    const err1 = await c1.nextInbox();
    assert.equal(err1.ok, false);
    assert.equal(err1.error.code, "bad_frame");
    await c1.closed; // connection closed by the daemon

    // Oversized declared length (> 8 MiB inbound cap), no body needed.
    const c2 = new TestClient();
    await c2.connected;
    assert.equal((await c2.nextInbox()).type, "hello");
    const huge = Buffer.alloc(4);
    huge.writeUInt32BE(9 * 1024 * 1024, 0);
    c2.sendRaw(huge);
    const err2 = await c2.nextInbox();
    assert.equal(err2.ok, false);
    assert.equal(err2.error.code, "bad_frame");
    await c2.closed;

    // Unsupported protocol version: structured error + close.
    const c3 = new TestClient();
    await c3.connected;
    assert.equal((await c3.nextInbox()).type, "hello");
    c3.sendRaw(
      proto.encodeFrame({ protocol_version: 999, id: "x1", type: "status" }),
    );
    const err3 = await c3.nextInbox();
    assert.equal(err3.ok, false);
    assert.equal(err3.error.code, "unsupported_version");
    await c3.closed;

    // The daemon keeps serving other connections.
    const c4 = new TestClient();
    await c4.connected;
    const st = await c4.request({ type: "status" });
    assert.equal(st.ok, true);
    assert.equal(st.state, "ready");
    c4.close();
  } finally {
    await daemon.stop();
    _resetCaches();
  }
});

// ---------------------------------------------------------------------------
// DEGRADED: refused generation with no loadable fallback
// ---------------------------------------------------------------------------
test("degraded: corrupt only generation -> degraded state, structured reason, immediate errors", async () => {
  const MV = "q1-degraded-mv";
  seedGeneration(MV, { n: 3, token: "dgtok" });
  // Corrupt the ONLY generation's bm25 member in place. Generation 0 has no
  // previous and no retention snapshot (those appear when a successor save
  // starts), so verification refuses everything and loadIndices fail-closes
  // to empty indices.
  writeFileSync(join(MEMORY_ROOT, "indices", MV, "bm25.json"), "garbage");
  _resetCaches();

  const daemon = new Queryd({ modelVersions: [MV], watchIntervalMs: 150 });
  await daemon.start();
  await daemon.ready;
  const client = new TestClient();
  try {
    await client.connected;
    assert.equal(daemon.state, "degraded");
    const st = await client.request({ type: "status" });
    assert.equal(st.state, "degraded");
    assert.equal(st.models[0].degraded, true);
    assert.ok(st.models[0].degraded_reason.code, "structured degraded reason");

    const resp = await client.request({
      type: "bm25_search",
      model_version: MV,
      query_text: "dgtok0",
      k: 5,
    });
    assert.equal(resp.ok, false);
    assert.equal(resp.error.code, "degraded");

    // Self-healing: a NEW published generation moves the manifest
    // fingerprint, the watch reloads it, and the daemon returns to READY.
    seedGeneration(MV, { n: 2, token: "healtok", seedBase: 80 });
    const deadline = Date.now() + 10000;
    for (;;) {
      const st2 = await client.request({ type: "status" });
      if (st2.state === "ready" && st2.models[0].degraded === false) break;
      assert.ok(Date.now() < deadline, "daemon never recovered from degraded");
      await sleep(50);
    }
    const healed = await client.request({
      type: "bm25_search",
      model_version: MV,
      query_text: "healtok1",
      k: 5,
    });
    assert.equal(healed.ok, true);
    assert.ok(healed.results.length > 0, "recovered generation serves content");
  } finally {
    client.close();
    await daemon.stop();
    _resetCaches();
  }
});

// ---------------------------------------------------------------------------
// (a) PER-MODEL DEGRADED ISOLATION: a healthy model serves while a SEPARATE
//     model is degraded; the aggregate roll-up stays degraded. RED on the
//     pre-fix daemon, where the `state === "degraded"` blanket in _onFrame
//     refuses EVERY query before resolving frame.model_version.
// ---------------------------------------------------------------------------
test("(a) per-model degraded: the healthy model serves while another is degraded; aggregate stays degraded", async () => {
  const MV_OK = "q1-multi-ok";
  const MV_BAD = "q1-multi-bad";
  seedGeneration(MV_OK, { n: 3, token: "oktok", seedBase: 200 });
  seedGeneration(MV_BAD, { n: 3, token: "badtok", seedBase: 210 });
  // Corrupt MV_BAD's ONLY generation in place (gen 0 has no previous/retention
  // fallback), exactly like the single-model degraded test: verification
  // refuses everything, loadIndices fail-closes to empty -> assessModelHealth
  // marks MV_BAD degraded while MV_OK loads clean.
  writeFileSync(join(MEMORY_ROOT, "indices", MV_BAD, "bm25.json"), "garbage");
  _resetCaches();

  const daemon = new Queryd({
    modelVersions: [MV_OK, MV_BAD],
    watchIntervalMs: 60000,
  });
  await daemon.start();
  await daemon.ready;
  const client = new TestClient();
  try {
    await client.connected;

    // The aggregate roll-up is degraded (one of two models is degraded)...
    assert.equal(daemon.state, "degraded");
    const st = await client.request({ type: "status" });
    assert.equal(st.state, "degraded");
    const byMv = new Map(st.models.map((m) => [m.model_version, m]));
    assert.equal(byMv.get(MV_OK).degraded, false);
    assert.equal(byMv.get(MV_BAD).degraded, true);
    assert.ok(byMv.get(MV_BAD).degraded_reason.code, "structured per-model reason");

    // ...yet the HEALTHY model serves with real results. RED pre-fix: the
    // aggregate degraded blanket refused this before resolving model_version.
    const okResp = await client.request({
      type: "bm25_search",
      model_version: MV_OK,
      query_text: "oktok0",
      k: 5,
    });
    assert.equal(okResp.ok, true, JSON.stringify(okResp));
    assert.ok(okResp.results.length > 0, "healthy model serves results");
    assert.equal(okResp.generation, 0);

    // The degraded model's OWN query still refuses with a degraded error.
    const badResp = await client.request({
      type: "bm25_search",
      model_version: MV_BAD,
      query_text: "badtok0",
      k: 5,
    });
    assert.equal(badResp.ok, false);
    assert.equal(badResp.error.code, "degraded");
    assert.equal(badResp.state, "degraded");

    // Serving the healthy model never changes the aggregate roll-up.
    const st2 = await client.request({ type: "status" });
    assert.equal(st2.state, "degraded");
  } finally {
    client.close();
    await daemon.stop();
    _resetCaches();
  }
});

// ---------------------------------------------------------------------------
// (b) PER-MODEL RELOAD ISOLATION: while ONE model re-deserializes a new
//     generation (its load stalled on the slow-load hook), a SEPARATE model
//     serves normally and the reloading model returns loading. RED on the
//     pre-fix daemon, where _reload flips the GLOBAL state to "loading" and
//     every query — including the untouched model's — is LOADING-refused.
// ---------------------------------------------------------------------------
test("(b) per-model reload: a healthy model serves during another model's slow reload; the reloading model returns loading", async () => {
  const MV_STABLE = "q1-reload-stable";
  const MV_RELOAD = "q1-reload-target";
  seedGeneration(MV_STABLE, { n: 3, token: "stabletok", seedBase: 300 });
  seedGeneration(MV_RELOAD, { n: 3, token: "reloadtok", seedBase: 310 });

  const daemon = new Queryd({
    modelVersions: [MV_STABLE, MV_RELOAD],
    watchIntervalMs: 100,
  });
  await daemon.start();
  await daemon.ready;
  assert.equal(daemon.state, "ready");
  const client = new TestClient();
  try {
    await client.connected;

    // Stall the reload of MV_RELOAD ONLY. The hook fires per model load and is
    // keyed on the model version, so the (already-complete) initial load and
    // the stable model are never gated.
    const gate = deferred();
    daemon._setSlowLoadHook((mv) =>
      mv === MV_RELOAD ? gate.promise : Promise.resolve(),
    );

    // Publish a NEW generation for MV_RELOAD -> the watch tick reloads it.
    seedGeneration(MV_RELOAD, { n: 2, token: "reloadtok2", seedBase: 320 });

    // Wait until the reload has actually begun (MV_RELOAD is in the reloading
    // set, stalled on the hook).
    const startDeadline = Date.now() + 10000;
    while (!daemon._reloadingModels.has(MV_RELOAD)) {
      assert.ok(Date.now() < startDeadline, "reload never started");
      await sleep(20);
    }
    // A reload NEVER flips the global aggregate state to loading.
    assert.equal(daemon.state, "ready");

    // The OTHER model serves normally throughout the reload window. RED
    // pre-fix: the global LOADING flip refuses this untouched model's query.
    const stableResp = await client.request({
      type: "bm25_search",
      model_version: MV_STABLE,
      query_text: "stabletok0",
      k: 5,
    });
    assert.equal(stableResp.ok, true, JSON.stringify(stableResp));
    assert.ok(stableResp.results.length > 0, "stable model serves during reload");

    // The reloading model's OWN query returns loading.
    const reloadResp = await client.request({
      type: "bm25_search",
      model_version: MV_RELOAD,
      query_text: "reloadtok0",
      k: 5,
    });
    assert.equal(reloadResp.ok, false);
    assert.equal(reloadResp.error.code, "loading");
    assert.equal(reloadResp.state, "loading");

    // Release the stalled reload: MV_RELOAD swaps to the new generation and
    // serves its new content; the reloading set drains.
    gate.resolve();
    const healDeadline = Date.now() + 10000;
    for (;;) {
      if (!daemon._reloadingModels.has(MV_RELOAD)) {
        const st = await client.request({ type: "status" });
        const m = st.models.find((x) => x.model_version === MV_RELOAD);
        if (m.generation === 1 && st.state === "ready") break;
      }
      assert.ok(Date.now() < healDeadline, "reload never completed");
      await sleep(30);
    }
    const afterReload = await client.request({
      type: "bm25_search",
      model_version: MV_RELOAD,
      query_text: "reloadtok20",
      k: 5,
    });
    assert.equal(afterReload.ok, true);
    assert.ok(
      afterReload.results.length > 0,
      "reloaded model serves the new generation's content",
    );
    assert.equal(afterReload.generation, 1);
  } finally {
    daemon._setSlowLoadHook(null);
    client.close();
    await daemon.stop();
    _resetCaches();
  }
});

// ---------------------------------------------------------------------------
// (c) INTERNAL FAULT CLASSIFICATION: a corrupt-state throw out of a resident
//     index is a daemon-internal fault, NOT a request-shape error — the
//     response carries the retryable internal code, never bad_request, and
//     through the client it becomes the retryable QuerydUnavailableError (not
//     the non-retryable QuerydBadRequestError). RED pre-fix: the _run catch-all
//     wrapped every throw as bad_request.
// ---------------------------------------------------------------------------
test("(c) internal _execute throw classifies as retryable-internal, never bad_request", async () => {
  const MV = "q1-internal-mv";
  seedGeneration(MV, { n: 2, token: "intok", seedBase: 400 });
  const daemon = new Queryd({ modelVersions: [MV], watchIntervalMs: 60000 });
  await daemon.start();
  await daemon.ready;
  const client = new TestClient();
  try {
    await client.connected;

    // Sanity: the model serves before we corrupt its resident state.
    const okBefore = await client.request({
      type: "bm25_search",
      model_version: MV,
      query_text: "intok0",
      k: 5,
    });
    assert.equal(okBefore.ok, true);

    // Force the resident index to throw on search: a daemon-internal
    // corrupt-state fault, NOT a request-shape validation failure.
    const entry = daemon.models.get(MV);
    entry.bm25.search = () => {
      throw new Error("corrupt bm25 resident state");
    };

    const resp = await client.request({
      type: "bm25_search",
      model_version: MV,
      query_text: "intok0",
      k: 5,
    });
    assert.equal(resp.ok, false);
    assert.notEqual(
      resp.error.code,
      "bad_request",
      "an internal fault must never be classified bad_request (non-retryable)",
    );
    assert.equal(
      resp.error.code,
      "internal",
      "daemon-internal faults carry the retryable internal code",
    );

    // Through the real client this maps via the generic fallthrough to the
    // retryable QuerydUnavailableError, never QuerydBadRequestError.
    const qcMod = await import("../../lib/recall/queryd-client.js");
    const qClient = new qcMod.QuerydClient();
    try {
      await assert.rejects(
        () => qClient.bm25Search(MV, "intok0", 5),
        (e) => {
          assert.ok(
            e instanceof qcMod.QuerydUnavailableError,
            `expected QuerydUnavailableError, got ${e && e.stack}`,
          );
          assert.ok(
            !(e instanceof qcMod.QuerydBadRequestError),
            "internal must not surface as the non-retryable bad-request error",
          );
          assert.equal(e.retryable, true);
          assert.equal(e.reason, "internal");
          return true;
        },
      );
    } finally {
      qClient.close();
    }
  } finally {
    client.close();
    await daemon.stop();
    _resetCaches();
  }
});

// ---------------------------------------------------------------------------
// (c2) hnsw_search fault classification: a corrupt resident-HNSW throw
//      (native addon / malformed in-memory vector out of searchKnn) is a
//      daemon-internal fault -> retryable internal -> QuerydUnavailableError
//      -> loud degrade, NEVER bad_request -> silently-empty dense leg. A
//      genuine request-shape throw (wrong dims / non-unit-norm), which carries
//      the 'HnswIndex.search' label, MUST stay bad_request. RED pre-fix: the
//      hnsw_search per-call catch wrapped every throw as bad_request.
// ---------------------------------------------------------------------------
test("(c2) corrupt hnsw.search is retryable-internal; request-shape stays bad_request", async () => {
  const MV = "q1-hnsw-internal-mv";
  seedGeneration(MV, { n: 3, token: "hntok", seedBase: 500 });
  const daemon = new Queryd({ modelVersions: [MV], watchIntervalMs: 60000 });
  await daemon.start();
  await daemon.ready;
  const client = new TestClient();
  try {
    await client.connected;

    // POSITIVE (must stay bad): a genuine wrong-length vector passes the
    // daemon's non-empty-finite-array check, then fails HnswIndex.search's
    // dims validation (length 3 vs dims=8). That throw carries the
    // 'HnswIndex.search' label and MUST remain bad_request so recall's
    // emptyOnBadRequest empties only this leg. Assert against the REAL index
    // before we corrupt it.
    const shapeResp = await client.request({
      type: "hnsw_search",
      model_version: MV,
      vector: [0.1, 0.2, 0.3],
      k: 5,
    });
    assert.equal(shapeResp.ok, false);
    assert.equal(
      shapeResp.error.code,
      "bad_request",
      "a real request-shape (dims) throw must stay bad_request",
    );

    // Force the resident HNSW to throw a NON-request-shape fault: a corrupt
    // native-addon / malformed in-memory vector fault, whose message does NOT
    // carry the 'HnswIndex.search' label.
    const entry = daemon.models.get(MV);
    entry.hnsw.search = () => {
      throw new Error("native addon corrupt");
    };

    const resp = await client.request({
      type: "hnsw_search",
      model_version: MV,
      vector: unitVec(500),
      k: 5,
    });
    assert.equal(resp.ok, false);
    assert.notEqual(
      resp.error.code,
      "bad_request",
      "a corrupt-resident-HNSW fault must never be classified bad_request (would silently empty the dense leg)",
    );
    assert.equal(
      resp.error.code,
      "internal",
      "corrupt resident-HNSW faults carry the retryable internal code",
    );

    // Through the real client this maps to the retryable QuerydUnavailableError,
    // never QuerydBadRequestError — mirroring the bm25 assertions above.
    const qcMod = await import("../../lib/recall/queryd-client.js");
    const qClient = new qcMod.QuerydClient();
    try {
      await assert.rejects(
        () => qClient.hnswSearch(MV, unitVec(500), 5),
        (e) => {
          assert.ok(
            e instanceof qcMod.QuerydUnavailableError,
            `expected QuerydUnavailableError, got ${e && e.stack}`,
          );
          assert.ok(
            !(e instanceof qcMod.QuerydBadRequestError),
            "a corrupt HNSW must not surface as the non-retryable bad-request error",
          );
          assert.equal(e.retryable, true);
          assert.equal(e.reason, "internal");
          return true;
        },
      );
    } finally {
      qClient.close();
    }
  } finally {
    client.close();
    await daemon.stop();
    _resetCaches();
  }
});

// ---------------------------------------------------------------------------
// Hermeticity pin
// ---------------------------------------------------------------------------
test("ledgers/memory.jsonl was never created by this suite", () => {
  assert.ok(
    !existsSync(join(process.env.LEDGERS_BASE_DIR, "memory.jsonl")),
    "suite must never touch a memory ledger",
  );
});
