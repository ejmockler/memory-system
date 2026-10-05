#!/usr/bin/env node
// queryd.js — Q1 resident query daemon.
//
// ONE resident process owns the deserialized BM25+HNSW indices per model
// version and serves index queries over a unix socket, so N concurrent
// sessions stop each holding a multi-GB HNSW copy and paying the per-session
// index load. Q2 wires lib/tools/recall.js as a thin client; this module owns
// ONLY the daemon: protocol serving, lifecycle, and lease discipline. There
// is deliberately NO in-process query fallback here — a daemon outage is a
// client-visible error and the client decides (Q2's concern).
//
// Request surface (see queryd-protocol.js): hello, status, bm25_search
// {model_version, query_text, k}, hnsw_search {model_version, vector, k},
// vector_fetch {model_version, ids[]}. bm25_search passes the RAW query
// string through to Bm25Index.search — tokenize/stopword/entity
// normalization live inside the index (bm25-index.js) and pre-tokenizing
// here would break the daemon-vs-direct equivalence gate. hnsw_search takes
// NO ef parameter (HnswIndex.search(query_vector, topK) is the whole
// surface). vector_fetch resolves each id via hnsw.getVectorByMemoryId,
// which covers both memory_id and index_vector_id (giant-chunk) callers.
//
// Index loading/verification/WAL-absorption is 100% delegated to
// lib/recall/index-cache.js loadIndices (manifest-gated S3 verification,
// generation-0 adoption, WAL-tail replay) — nothing of it is duplicated
// here. Synchronous deserialization is confined to the LOADING state
// (startup and generation-change reload); after READY the watch timer's
// steady-state cost is stat-level (manifest fingerprint stat + warm-hit
// loadIndices, which absorbs only the new WAL tail).
//
// States: loading (queries -> immediate {state:"loading"} error, never
// queued across states), ready, degraded (no loadable generation ->
// structured reason; queries -> immediate degraded error).
//
// Single instance: queryd.lock in $MEMORY_ROOT/storage/queryd, a LOCAL
// implementation of the canonical acquireExclusiveLockFile discipline
// (kb/architecture.md § acquireExclusiveLockFile). Local because the
// exported WAL lease helpers (index-wal.js acquireFlushLease/heartbeatLease/
// releaseLease) hardwire the index-wal.lock filename and per-version dir.
// Sanctioned deviations, scoped to queryd.lock (mirroring the WAL flush
// lease's documented deviation pattern):
//   1. Non-blocking acquire: contention makes ONE stale-reclaim attempt and
//      then fails (structured error, nonzero exit) instead of
//      retry-with-backoff — a second daemon instance must refuse fast, and
//      nothing is lost (the first instance keeps serving).
//   2. Stale reclaim requires mtime-age AND pid-dead (the canonical
//      reference reclaims on either): the holder is a long-lived daemon
//      heartbeating at half the stale TTL, so a live pid with a stale
//      mtime means a wedged-but-alive daemon that must NOT have its socket
//      pulled out from under it.
//
// LOGGING DISCIPLINE: stderr lines are structured JSON with codes, model
// versions, generations, and paths ONLY — never query text, vectors, or any
// other request/response content.
//
// Node stdlib only.

import { connect as netConnect, createServer } from "node:net";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  futimesSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

import { MEMORY_ROOT, STORAGE_DIR } from "../lib/config.js";
import { CAPS } from "../lib/validation.js";
import { loadIndices } from "../lib/recall/index-cache.js";
import {
  manifestPathFor,
  readActiveManifest,
  verifyGenerationMembers,
} from "../lib/recall/index-manifest.js";
import { GEMINI_CLIENT_CONSTANTS } from "../lib/gemini-client.js";
import {
  ERROR_CODES,
  FrameDecoder,
  MAX_INBOUND_FRAME_BYTES,
  MAX_OUTBOUND_FRAME_BYTES,
  PROTOCOL_VERSION,
  VECTOR_FETCH_MAX_IDS,
  clampDeadlineMs,
  encodeFrame,
  errorResponse,
  helloFrame,
} from "./queryd-protocol.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const QUERYD_SOCKET_FILE = "queryd.sock";
export const QUERYD_LOCK_FILE = "queryd.lock";

// $MEMORY_ROOT/storage/queryd (STORAGE_DIR honors the STORAGE_BASE_DIR env
// override for hermetic tests, exactly like every other storage consumer).
export function querydPaths() {
  const dir = join(STORAGE_DIR, "queryd");
  return {
    dir,
    socketPath: join(dir, QUERYD_SOCKET_FILE),
    lockPath: join(dir, QUERYD_LOCK_FILE),
  };
}

// indices/<model_version> — the per-version index tree layout
// (kb/phase3-v0-contracts.md § 7; same convention as index-cache.js's
// unexported indexPathsFor).
function indicesDirFor(modelVersion) {
  return join(MEMORY_ROOT, "indices", modelVersion);
}

// Same stat-fingerprint scheme index-cache.js uses for its cache identity —
// the watch timer compares this across ticks to detect a generation publish.
function statFingerprint(path) {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "missing";
  }
}

// Model versions this daemon serves. --models=a,b / QUERYD_MODEL_VERSIONS
// override; the default is the two versions recall.js actually queries: the
// active local model and the legacy Gemini fallback.
export function defaultModelVersions() {
  const env = process.env.QUERYD_MODEL_VERSIONS;
  if (typeof env === "string" && env.trim().length > 0) {
    return [...new Set(env.split(",").map((s) => s.trim()).filter(Boolean))];
  }
  return [
    ...new Set([
      CAPS.ACTIVE_EMBED_MODEL_VERSION,
      GEMINI_CLIENT_CONSTANTS.GEMINI_EMBEDDING_MODEL_VERSION,
    ]),
  ];
}

// ---------------------------------------------------------------------------
// queryd.lock — local acquireExclusiveLockFile implementation (see header)
// ---------------------------------------------------------------------------

const LOCK_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  fsConstants.O_NOFOLLOW;

function _pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !(e && e.code === "ESRCH");
  }
}

// Sibling hand-rolled O_EXCL pid-lockfile implementations that deliberately do
// NOT share a module (each has a scoped deviation): lib/nonce-store.js,
// lib/policy-events.js, lib/synthesis/damping-log.js, lib/recall/index-wal.js.
// queryd.lock's sanctioned deviations are documented in the module header
// (kb/architecture.md § acquireExclusiveLockFile) — no shared-module
// extraction here (it would add coupling/imports to a live daemon).
function _tryCreateLock(lockPath) {
  let fd;
  try {
    fd = openSync(lockPath, LOCK_FLAGS, 0o600);
  } catch (e) {
    if (e && e.code === "EEXIST") return null;
    throw e;
  }
  // Post-open nlink === 1 check (canonical step 3: defeat swap-during-acquire).
  const st = fstatSync(fd);
  if (st.nlink !== 1) {
    closeSync(fd);
    return null;
  }
  writeSync(
    fd,
    JSON.stringify({ pid: process.pid, heartbeat_ts: new Date().toISOString() }),
  );
  fsyncSync(fd);
  return fd;
}

// ONE stale-reclaim attempt: mtime-age > STALE_LOCK_RECOVERY_SECONDS AND the
// recorded pid is dead (see header deviation 2). Returns true iff the stale
// sidecar was removed (or was already gone).
function _reclaimStaleLockIfDead(lockPath) {
  let st;
  try {
    st = statSync(lockPath);
  } catch (e) {
    return e && e.code === "ENOENT"; // already gone — retry the create
  }
  let body = null;
  try {
    body = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    body = null;
  }
  const stale =
    Date.now() - st.mtimeMs > CAPS.STALE_LOCK_RECOVERY_SECONDS * 1000;
  const pid = body != null && Number.isInteger(body.pid) ? body.pid : null;
  const dead = pid == null || !_pidAlive(pid);
  if (!(stale && dead)) return false;
  try {
    unlinkSync(lockPath);
  } catch (e) {
    if (!(e && e.code === "ENOENT")) throw e;
  }
  return true;
}

/**
 * acquireQuerydLease(dir) -> {fd, lockPath} | null (contended).
 */
export function acquireQuerydLease(dir) {
  const lockPath = join(dir, QUERYD_LOCK_FILE);
  let fd = _tryCreateLock(lockPath);
  if (fd == null && _reclaimStaleLockIfDead(lockPath)) {
    fd = _tryCreateLock(lockPath);
  }
  if (fd == null) return null;
  return { fd, lockPath };
}

export function heartbeatQuerydLease(lease) {
  if (lease == null) return;
  try {
    const now = new Date();
    futimesSync(lease.fd, now, now);
  } catch {
    // Advisory — a failed heartbeat surfaces as staleness, never a crash.
  }
}

export function releaseQuerydLease(lease) {
  if (lease == null) return;
  try {
    closeSync(lease.fd);
  } catch {
    // ignore
  }
  try {
    unlinkSync(lease.lockPath);
  } catch (e) {
    if (!(e && e.code === "ENOENT")) {
      // Non-fatal: the next acquirer's stale-reclaim recovers.
    }
  }
}

// ---------------------------------------------------------------------------
// Stale-socket probe
// ---------------------------------------------------------------------------

// Connect-probe an existing socket file. Resolves true iff something ACCEPTS
// the connection; ECONNREFUSED/ENOENT/any error/timeout -> false (dead).
export function probeSocketAlive(socketPath, timeoutMs = 500) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (alive) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        // ignore
      }
      resolve(alive);
    };
    const sock = netConnect(socketPath);
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
}

// ---------------------------------------------------------------------------
// Per-model health assessment (status/degraded signal)
// ---------------------------------------------------------------------------

// loadIndices fail-closes to EMPTY indices when no generation candidate
// survives verification — indistinguishable, by its return value alone, from
// a legitimately empty bootstrap tree. Disambiguate via the exported
// manifest surface: an unreadable manifest, or an active generation whose
// members refuse verification while the loaded indices came back empty
// despite the manifest naming members, is DEGRADED with the structured
// verifier error as the reason. verifyGenerationMembers rides the S3
// digest cache, so the healthy-path cost here is stat-level. This runs once
// per (re)load, never per request or per watch tick.
function assessModelHealth(dir, bm25, hnsw) {
  const mread = readActiveManifest(dir);
  if (mread.error != null) {
    return { degraded: true, generation: null, reason: mread.error };
  }
  if (mread.manifest == null) {
    // Bootstrap/legacy tree — empty indices are the documented degrade-to-
    // empty contract, not corruption.
    return { degraded: false, generation: null, reason: null };
  }
  const manifest = mread.manifest;
  const v = verifyGenerationMembers(dir, manifest.members);
  if (v.ok) {
    return { degraded: false, generation: manifest.generation, reason: null };
  }
  const loadedEmpty = bm25.size() === 0 && hnsw.size() === 0;
  const namesMembers =
    manifest.members.bm25 != null || manifest.members.hnsw != null;
  if (loadedEmpty && namesMembers) {
    // Active generation refused AND nothing loadable fell back -> degraded.
    return { degraded: true, generation: manifest.generation, reason: v.error };
  }
  // A retained/previous fallback (plus WAL replay) is serving content: not
  // degraded, but carry the active-generation refusal as a breadcrumb.
  return { degraded: false, generation: manifest.generation, reason: v.error };
}

// Trim a structured verifier/manifest error to log/status-safe fields.
function trimReason(reason) {
  if (reason == null || typeof reason !== "object") return null;
  return {
    code: reason.code ?? null,
    member: reason.member ?? null,
    file: reason.file ?? null,
  };
}

function logLine(obj) {
  // Structured stderr only — codes/versions/paths, never content.
  process.stderr.write(`${JSON.stringify({ queryd: true, ...obj })}\n`);
}

// ---------------------------------------------------------------------------
// The daemon
// ---------------------------------------------------------------------------

const QUERY_TYPES = new Set(["bm25_search", "hnsw_search", "vector_fetch"]);
const MAX_K = 10000;

// Internal-fault code (retryable): a daemon-side fault — a throw out of a
// resident index (corrupt state), or any unexpected _execute exception — is
// NOT request-shape and must never be classified BAD_REQUEST (non-retryable).
// Kept as a module-local constant rather than added to queryd-protocol's
// frozen ERROR_CODES so the wire-protocol module stays byte-unchanged; the
// client's generic fallthrough already maps any unknown code (this one
// included) to a retryable QuerydUnavailableError.
const INTERNAL_ERROR_CODE = "internal";

export class Queryd {
  constructor(opts = {}) {
    this.modelVersions = Array.isArray(opts.modelVersions)
      ? [...new Set(opts.modelVersions)]
      : defaultModelVersions();
    // Bounded fair queue caps (defaults per spec; overridable for tests).
    this.maxInFlight = opts.maxInFlight ?? 4;
    this.maxQueued = opts.maxQueued ?? 64;
    this.maxQueuedPerConn = opts.maxQueuedPerConn ?? 8;
    // Generation watch cadence (>=2s in production; tests may lower it).
    this.watchIntervalMs = opts.watchIntervalMs ?? 2000;

    this.state = "loading";
    this.models = new Map(); // mv -> {bm25, hnsw, generation, manifestFp, degraded, degradedReason}
    // Model versions mid-reload. Tracked in a side Set (never on the shared
    // entry objects that in-flight requests captured by ref) so a reload gates
    // ONLY the reloading model's admission — every other model keeps serving.
    this._reloadingModels = new Set();
    this.queue = [];
    this.inFlight = 0;
    this.connections = new Set();

    this._server = null;
    this._lease = null;
    this._startedAtMs = null;
    this._watchTimer = null;
    this._heartbeatTimer = null;
    this._stopping = false;
    this._stopPromise = null;
    this._drainWaiters = [];
    this._stallHook = null; // test hook: awaited before each handler runs
    this._slowLoadHook = null; // test hook: awaited before each model load
    this.ready = null; // promise: initial load complete (state left "loading")
  }

  // Test hooks (codebase convention, cf. index-cache _setAfterVerifyHook).
  _setStallHook(fn) {
    this._stallHook = typeof fn === "function" ? fn : null;
  }

  _setSlowLoadHook(fn) {
    this._slowLoadHook = typeof fn === "function" ? fn : null;
  }

  /**
   * start() — acquire the lease, recover a stale socket, listen, and kick
   * off the initial LOADING-state index load. Resolves once the socket is
   * accepting (queries during the load get immediate loading errors);
   * `this.ready` resolves when the initial load completes.
   *
   * Throws with .code "queryd_lock_held" (second instance) or
   * "queryd_socket_alive" (live socket under a free lease — anomalous).
   */
  async start() {
    const { dir, socketPath } = querydPaths();
    // 0700 dir: mkdir's mode is umask-masked, so chmod pins it explicitly.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);

    this._lease = acquireQuerydLease(dir);
    if (this._lease == null) {
      const err = new Error(
        `queryd.lock held by another instance in ${dir}; refusing to start`,
      );
      err.code = "queryd_lock_held";
      throw err;
    }

    try {
      // Stale-socket recovery: we HOLD the lease (it was free), so a socket
      // that still ACCEPTS is anomalous — refuse rather than hijack. A dead
      // socket file (ECONNREFUSED/timeout) is unlinked and replaced.
      if (existsSync(socketPath)) {
        const alive = await probeSocketAlive(socketPath);
        if (alive) {
          const err = new Error(
            `live socket at ${socketPath} while queryd.lock was free; refusing to start`,
          );
          err.code = "queryd_socket_alive";
          throw err;
        }
        try {
          unlinkSync(socketPath);
        } catch (e) {
          if (!(e && e.code === "ENOENT")) throw e;
        }
      }

      this._server = createServer((sock) => this._onConnection(sock));
      await new Promise((resolve, reject) => {
        this._server.once("error", reject);
        this._server.listen(socketPath, () => {
          this._server.removeListener("error", reject);
          resolve();
        });
      });
      this._server.on("error", (e) => {
        logLine({ event: "server_error", code: e?.code ?? null });
      });
      // 0600 socket, immediately after listen.
      chmodSync(socketPath, 0o600);
    } catch (e) {
      releaseQuerydLease(this._lease);
      this._lease = null;
      throw e;
    }

    this._startedAtMs = Date.now();
    this._heartbeatTimer = setInterval(
      () => heartbeatQuerydLease(this._lease),
      (CAPS.STALE_LOCK_RECOVERY_SECONDS / 2) * 1000,
    );
    this._heartbeatTimer.unref();

    // Initial load runs async so the socket can answer with loading errors
    // while indices deserialize (the sync deserialize itself is confined to
    // the LOADING state).
    this.ready = this._initialLoad();
    return this;
  }

  async _initialLoad() {
    this.state = "loading";
    for (const mv of this.modelVersions) {
      await this._loadModel(mv);
    }
    this._enterServingState();
    if (this._stopping) return; // stop() raced the load — never arm the timer
    this._watchTimer = setInterval(
      () => this._onWatchTick(),
      this.watchIntervalMs,
    );
    this._watchTimer.unref();
  }

  // Load one model version via index-cache loadIndices (manifest-gated
  // verification, gen-0 adoption, WAL-tail replay all inside). The manifest
  // fingerprint is captured BEFORE the load: a publish racing the load makes
  // the recorded fp stale, so the next watch tick reloads — never serves a
  // stale generation unnoticed.
  async _loadModel(mv) {
    if (this._slowLoadHook != null) await this._slowLoadHook(mv);
    const dir = indicesDirFor(mv);
    const manifestFp = statFingerprint(manifestPathFor(dir));
    // FU2 — loadIndices additively reports a refused ACTIVE generation
    // ({code, member?, served:"fallback"|"empty"} | null). Carrying it on
    // the model entry (and out through _statusResponse) closes
    // assessModelHealth's deserialize blind spot: the marker comes from the
    // LOAD itself, so a verify-clean generation whose bytes fail deserialize
    // is no longer invisible to daemon-mode recall.
    const { bm25, hnsw, generation_refused } = loadIndices(mv);
    const health = assessModelHealth(dir, bm25, hnsw);
    this.models.set(mv, {
      bm25,
      hnsw,
      generation: health.generation,
      manifestFp,
      degraded: health.degraded,
      degradedReason: trimReason(health.reason),
      generationRefused: generation_refused ?? null,
    });
    logLine({
      event: "model_loaded",
      model_version: mv,
      generation: health.generation,
      bm25_size: bm25.size(),
      hnsw_size: hnsw.size(),
      degraded: health.degraded,
      reason: trimReason(health.reason),
      ...(generation_refused != null ? { generation_refused } : {}),
    });
  }

  _enterServingState() {
    const anyDegraded = [...this.models.values()].some((e) => e.degraded);
    this.state = anyDegraded ? "degraded" : "ready";
    logLine({ event: "state", state: this.state });
  }

  // Generation watch: stat the manifest fingerprint per model version. On a
  // change: LOADING -> loadIndices (its manifest-fp cache invalidation
  // returns the NEW generation objects) -> atomic entry swap -> READY.
  // In-flight requests captured the old entry ref at dispatch and complete
  // on the old objects. On NO change: a warm-hit loadIndices per model
  // absorbs any new WAL tail into the resident objects (stat-level when the
  // WAL is unchanged) so promoted-but-not-yet-published facts stay visible.
  _onWatchTick() {
    // A reload no longer flips the global state, so overlap protection keys on
    // the per-model reloading Set (the initial load never arms this timer).
    if (this._stopping || this._reloadingModels.size > 0) return;
    const changed = [];
    for (const [mv, entry] of this.models) {
      const fp = statFingerprint(manifestPathFor(indicesDirFor(mv)));
      if (fp !== entry.manifestFp) changed.push(mv);
    }
    if (changed.length > 0) {
      this._reload(changed).catch((e) => {
        logLine({ event: "reload_failed", message: e?.message ?? String(e) });
        this._enterServingState();
      });
      return;
    }
    for (const [mv, entry] of this.models) {
      try {
        const r = loadIndices(mv); // warm hit + WAL-tail absorb
        if (r.bm25 !== entry.bm25 || r.hnsw !== entry.hnsw) {
          // Out-of-band member replacement fresh-loaded new objects without
          // a manifest change (rare; offline rebuild scripts). Swap + reassess.
          const dir = indicesDirFor(mv);
          const health = assessModelHealth(dir, r.bm25, r.hnsw);
          this.models.set(mv, {
            bm25: r.bm25,
            hnsw: r.hnsw,
            generation: health.generation,
            manifestFp: statFingerprint(manifestPathFor(dir)),
            degraded: health.degraded,
            degradedReason: trimReason(health.reason),
            // FU2 — see _loadModel: the marker rides the load result.
            generationRefused: r.generation_refused ?? null,
          });
          this._enterServingState();
        }
      } catch (e) {
        logLine({
          event: "wal_absorb_failed",
          model_version: mv,
          message: e?.message ?? String(e),
        });
      }
    }
  }

  async _reload(mvs) {
    logLine({ event: "generation_change", model_versions: mvs });
    // Per-model reload: the named models refuse admission (LOADING) while they
    // re-deserialize; every OTHER model keeps serving on its resident entry.
    // The global state is NEVER flipped to "loading" here — it is recomputed
    // as a pure aggregate roll-up in the finally.
    for (const mv of mvs) this._reloadingModels.add(mv);
    try {
      for (const mv of mvs) {
        await this._loadModel(mv);
      }
    } finally {
      for (const mv of mvs) this._reloadingModels.delete(mv);
      this._enterServingState();
    }
  }

  // -------------------------------------------------------------------------
  // Connections and framing
  // -------------------------------------------------------------------------

  _onConnection(sock) {
    this.connections.add(sock);
    sock._querydQueued = 0;
    sock.on("close", () => this.connections.delete(sock));
    sock.on("error", () => sock.destroy());
    const decoder = new FrameDecoder({ maxFrameBytes: MAX_INBOUND_FRAME_BYTES });
    this._send(sock, helloFrame(this.state));
    sock.on("data", (chunk) => {
      const { frames, error } = decoder.push(chunk);
      for (const frame of frames) this._onFrame(sock, frame);
      if (error != null) {
        // One structured error frame, then close (malformed/oversized frame).
        this._sendAndClose(
          sock,
          errorResponse(null, this.state, null, error.code, error.message),
        );
      }
    });
  }

  _send(sock, obj) {
    if (sock.destroyed || !sock.writable) return;
    let buf;
    try {
      buf = encodeFrame(obj, { maxBytes: MAX_OUTBOUND_FRAME_BYTES });
    } catch (e) {
      // Response exceeded the outbound cap: degrade to a structured error.
      buf = encodeFrame(
        errorResponse(
          obj?.id ?? null,
          this.state,
          obj?.generation ?? null,
          ERROR_CODES.BAD_REQUEST,
          `response exceeds outbound frame cap (${e.message}); narrow k/ids`,
        ),
        { maxBytes: MAX_OUTBOUND_FRAME_BYTES },
      );
    }
    sock.write(buf);
  }

  _sendAndClose(sock, obj) {
    if (sock.destroyed) return;
    try {
      sock.end(encodeFrame(obj, { maxBytes: MAX_OUTBOUND_FRAME_BYTES }));
    } catch {
      sock.destroy();
    }
  }

  _onFrame(sock, frame) {
    if (frame == null || typeof frame !== "object" || Array.isArray(frame)) {
      this._sendAndClose(
        sock,
        errorResponse(
          null,
          this.state,
          null,
          ERROR_CODES.BAD_FRAME,
          "frame must be a JSON object",
        ),
      );
      return;
    }
    const id =
      typeof frame.id === "string" || typeof frame.id === "number"
        ? frame.id
        : null;
    // Handshake discipline: every request carries protocol_version.
    if (frame.protocol_version !== PROTOCOL_VERSION) {
      this._sendAndClose(
        sock,
        errorResponse(
          id,
          this.state,
          null,
          ERROR_CODES.UNSUPPORTED_VERSION,
          `protocol_version ${PROTOCOL_VERSION} required`,
        ),
      );
      return;
    }
    if (frame.type === "hello") {
      this._send(sock, { ...helloFrame(this.state), id });
      return;
    }
    if (frame.type === "status") {
      // status is answered immediately in EVERY state (it is how clients and
      // the --status probe observe loading/degraded).
      this._send(sock, this._statusResponse(id));
      return;
    }
    if (typeof frame.type !== "string" || !QUERY_TYPES.has(frame.type)) {
      this._send(
        sock,
        errorResponse(
          id,
          this.state,
          null,
          ERROR_CODES.BAD_REQUEST,
          "unsupported request type",
        ),
      );
      return;
    }
    if (id == null) {
      this._send(
        sock,
        errorResponse(
          null,
          this.state,
          null,
          ERROR_CODES.BAD_REQUEST,
          "request id (string|number) required",
        ),
      );
      return;
    }
    if (this._stopping) {
      this._send(
        sock,
        errorResponse(id, this.state, null, ERROR_CODES.BUSY, "daemon draining"),
      );
      return;
    }
    // Initial-load blanket: after the initial load, `state` is a pure
    // aggregate roll-up and returns to "loading" ONLY during that first load
    // (a generation reload no longer flips it), so this check correctly means
    // "initial load in progress" — reject every query, never queued.
    if (this.state === "loading") {
      this._send(
        sock,
        errorResponse(
          id,
          "loading",
          null,
          ERROR_CODES.LOADING,
          "indices loading; retry",
        ),
      );
      return;
    }
    // Per-model admission: resolve the requested model FIRST, then gate on
    // THAT model's state. A model mid-reload rejects LOADING; a degraded model
    // rejects DEGRADED with its own reason. A HEALTHY model ALWAYS serves even
    // while another model is reloading or degraded — that is the whole point
    // of the per-model entry-swap. An unknown/unconfigured model_version is
    // neither reloading nor a degraded entry, so it falls through to enqueue
    // and _execute returns the unchanged bad_request.
    const mv =
      typeof frame.model_version === "string" ? frame.model_version : null;
    if (mv != null && this._reloadingModels.has(mv)) {
      this._send(
        sock,
        errorResponse(
          id,
          "loading",
          null,
          ERROR_CODES.LOADING,
          "model reloading; retry",
        ),
      );
      return;
    }
    const gateEntry = mv != null ? this.models.get(mv) : null;
    if (gateEntry != null && gateEntry.degraded) {
      this._send(
        sock,
        errorResponse(
          id,
          "degraded",
          null,
          ERROR_CODES.DEGRADED,
          `model ${mv} degraded: ${gateEntry.degradedReason?.code ?? "unknown"}`,
        ),
      );
      return;
    }
    // Bounded fair queue: per-connection cap first, then the global cap;
    // overflow is an immediate structured busy error (client decides).
    if ((sock._querydQueued ?? 0) >= this.maxQueuedPerConn) {
      this._send(
        sock,
        errorResponse(
          id,
          this.state,
          null,
          ERROR_CODES.BUSY,
          `per-connection queue cap (${this.maxQueuedPerConn}) reached`,
        ),
      );
      return;
    }
    if (this.queue.length >= this.maxQueued) {
      this._send(
        sock,
        errorResponse(
          id,
          this.state,
          null,
          ERROR_CODES.BUSY,
          `queue cap (${this.maxQueued}) reached`,
        ),
      );
      return;
    }
    sock._querydQueued += 1;
    this.queue.push({
      sock,
      frame,
      deadlineAt: Date.now() + clampDeadlineMs(frame.deadline_ms),
    });
    this._pump();
  }

  _degradedSummary() {
    const parts = [];
    for (const [mv, e] of this.models) {
      if (e.degraded) {
        parts.push(`${mv}: ${e.degradedReason?.code ?? "unknown"}`);
      }
    }
    return `no loadable index generation (${parts.join("; ")})`;
  }

  // -------------------------------------------------------------------------
  // Bounded fair queue + deadlines
  // -------------------------------------------------------------------------

  _pump() {
    while (this.inFlight < this.maxInFlight && this.queue.length > 0) {
      const item = this.queue.shift();
      item.sock._querydQueued -= 1;
      // Per-model dispatch gate: a reload or degrade that landed AFTER this
      // item was enqueued rejects it with the requested model's own state,
      // never the aggregate — a healthy model's queued work is never collateral
      // to another model's reload/degrade. (Initial-load LOADING stays a global
      // blanket.)
      const mv =
        typeof item.frame.model_version === "string"
          ? item.frame.model_version
          : null;
      if (this.state === "loading" || (mv != null && this._reloadingModels.has(mv))) {
        this._send(
          item.sock,
          errorResponse(
            item.frame.id,
            "loading",
            null,
            ERROR_CODES.LOADING,
            "indices loading; retry",
          ),
        );
        continue;
      }
      const dispatchEntry = mv != null ? this.models.get(mv) : null;
      if (dispatchEntry != null && dispatchEntry.degraded) {
        this._send(
          item.sock,
          errorResponse(
            item.frame.id,
            "degraded",
            null,
            ERROR_CODES.DEGRADED,
            this._degradedSummary(),
          ),
        );
        continue;
      }
      // Queued past deadline -> dropped with a timeout error.
      if (Date.now() > item.deadlineAt) {
        this._send(
          item.sock,
          errorResponse(
            item.frame.id,
            this.state,
            null,
            ERROR_CODES.TIMEOUT,
            "deadline exceeded while queued",
          ),
        );
        continue;
      }
      this.inFlight += 1;
      this._run(item)
        .catch((e) => {
          logLine({ event: "handler_error", message: e?.message ?? String(e) });
        })
        .finally(() => {
          this.inFlight -= 1;
          this._pump();
        });
    }
    this._checkDrain();
  }

  async _run(item) {
    const { frame } = item;
    // Capture the model entry ref NOW: a generation swap mid-request must
    // not retarget an in-flight request (it completes on the old objects).
    const entry =
      typeof frame.model_version === "string"
        ? (this.models.get(frame.model_version) ?? null)
        : null;
    let response;
    try {
      if (this._stallHook != null) await this._stallHook(frame.type);
      response = this._execute(frame, entry);
    } catch (e) {
      // A throw reaching this backstop is an unexpected daemon-internal fault:
      // every genuine request-shape validation returns via bad() inside
      // _execute. Classify it retryable (INTERNAL), never BAD_REQUEST.
      response = errorResponse(
        frame.id,
        this.state,
        entry?.generation ?? null,
        INTERNAL_ERROR_CODE,
        e?.message ?? String(e),
      );
    }
    // Running requests are checked at completion: a result computed past the
    // deadline is dropped in favor of the timeout error. The connection
    // stays usable either way.
    if (Date.now() > item.deadlineAt) {
      response = errorResponse(
        frame.id,
        this.state,
        entry?.generation ?? null,
        ERROR_CODES.TIMEOUT,
        "deadline exceeded during execution",
      );
    }
    this._send(item.sock, response);
  }

  // -------------------------------------------------------------------------
  // Handlers (synchronous over the captured entry)
  // -------------------------------------------------------------------------

  _execute(frame, entry) {
    const id = frame.id;
    const bad = (message) =>
      errorResponse(id, this.state, entry?.generation ?? null, ERROR_CODES.BAD_REQUEST, message);
    // A daemon-internal fault (corrupt resident-index throw) is retryable and
    // must NOT be conflated with a request-shape bad_request.
    const internal = (message) =>
      errorResponse(id, this.state, entry?.generation ?? null, INTERNAL_ERROR_CODE, message);
    if (entry == null) {
      return bad(
        `unknown model_version; configured: ${this.modelVersions.join(", ")}`,
      );
    }
    const k = frame.k == null ? 50 : frame.k;
    switch (frame.type) {
      case "bm25_search": {
        if (typeof frame.query_text !== "string") {
          return bad("query_text must be a string");
        }
        if (!Number.isInteger(k) || k < 1 || k > MAX_K) {
          return bad(`k must be an integer in [1, ${MAX_K}]`);
        }
        // RAW string straight through — tokenization/stopwords/entity
        // normalization live inside Bm25Index.search (equivalence gate). A
        // throw here is corrupt resident-index state (NOT request shape) ->
        // internal, mirroring hnsw_search's per-call catch below but with the
        // retryable code (hnsw's dims/unit-norm throws ARE request shape and
        // stay bad_request).
        let results;
        try {
          results = entry.bm25.search(frame.query_text, k);
        } catch (e) {
          return internal(e?.message ?? String(e));
        }
        return this._okEnvelope(id, entry, { results });
      }
      case "hnsw_search": {
        if (
          !Array.isArray(frame.vector) ||
          frame.vector.length === 0 ||
          !frame.vector.every((x) => typeof x === "number" && Number.isFinite(x))
        ) {
          return bad("vector must be a non-empty array of finite numbers");
        }
        if (!Number.isInteger(k) || k < 1 || k > MAX_K) {
          return bad(`k must be an integer in [1, ${MAX_K}]`);
        }
        let results;
        try {
          // NO ef parameter — HnswIndex.search(query_vector, topK) is the
          // entire search surface.
          results = entry.hnsw.search(frame.vector, k);
        } catch (e) {
          // Split by fault class, mirroring bm25_search. Request-shape throws
          // (dims mismatch, non-unit-norm query, invalid topK) all flow through
          // HnswIndex.search's _validateVector/l2NormAssert and carry the
          // 'HnswIndex.search' label substring -> stay bad_request, so recall's
          // emptyOnBadRequest legitimately empties only this leg. ANY OTHER
          // throw is a corrupt resident-index fault (native-addon / malformed
          // in-memory vector out of searchKnn) -> retryable internal, so a
          // corrupt HNSW surfaces as QuerydUnavailableError -> loud degrade
          // instead of a silently-empty dense leg.
          const msg = e?.message ?? String(e);
          return msg.includes("HnswIndex.search") ? bad(msg) : internal(msg);
        }
        return this._okEnvelope(id, entry, { results });
      }
      case "vector_fetch": {
        if (
          !Array.isArray(frame.ids) ||
          frame.ids.length === 0 ||
          frame.ids.length > VECTOR_FETCH_MAX_IDS ||
          !frame.ids.every((s) => typeof s === "string" && s.length > 0)
        ) {
          return bad(
            `ids must be 1..${VECTOR_FETCH_MAX_IDS} non-empty strings`,
          );
        }
        // getVectorByMemoryId covers bare memory_ids AND index_vector_ids
        // (giant chunk ids); unknown/tombstoned ids are structured nulls.
        const vectors = frame.ids.map((mid) => {
          const v = entry.hnsw.getVectorByMemoryId(mid);
          if (Array.isArray(v)) return { id: mid, vector: v };
          if (v != null && ArrayBuffer.isView(v)) {
            return { id: mid, vector: Array.from(v) };
          }
          return { id: mid, vector: null };
        });
        return this._okEnvelope(id, entry, { vectors });
      }
      default:
        return bad("unsupported request type");
    }
  }

  _okEnvelope(id, entry, fields) {
    return {
      id,
      ok: true,
      generation: entry?.generation ?? null,
      state: this.state,
      ...fields,
    };
  }

  _statusResponse(id) {
    return {
      id: id ?? null,
      ok: true,
      type: "status",
      generation: null,
      state: this.state,
      protocol_version: PROTOCOL_VERSION,
      pid: process.pid,
      uptime_s:
        this._startedAtMs != null
          ? (Date.now() - this._startedAtMs) / 1000
          : 0,
      rss_bytes: process.memoryUsage().rss,
      queue_depth: this.queue.length,
      in_flight: this.inFlight,
      models: [...this.models.entries()].map(([mv, e]) => ({
        model_version: mv,
        generation: e.generation,
        // Sizes are load-bearing for Q2: recall.js gates its active->fallback
        // decision on bm25.size()/hnsw.size().
        bm25_size: e.bm25.size(),
        hnsw_size: e.hnsw.size(),
        degraded: e.degraded === true,
        degraded_reason: e.degradedReason ?? null,
        // FU2 additive — {code, member?, served:"fallback"|"empty"} when this
        // model's ACTIVE generation was refused at load; OMITTED when null so
        // healthy status responses stay byte-identical. recall.js threads it
        // onto the queryd-mode brief envelope.
        ...(e.generationRefused != null
          ? { generation_refused: e.generationRefused }
          : {}),
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Graceful lifecycle
  // -------------------------------------------------------------------------

  _checkDrain() {
    if (!this._stopping) return;
    if (this.inFlight === 0 && this.queue.length === 0) {
      const waiters = this._drainWaiters;
      this._drainWaiters = [];
      for (const w of waiters) w();
    }
  }

  _drained() {
    if (this.inFlight === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this._drainWaiters.push(resolve));
  }

  /**
   * stop() — graceful drain: stop accepting, finish in-flight (and already
   * queued) requests, close connections, unlink the socket, release the
   * lease. Idempotent.
   */
  stop() {
    if (this._stopPromise != null) return this._stopPromise;
    this._stopPromise = this._stop();
    return this._stopPromise;
  }

  async _stop() {
    this._stopping = true;
    const { socketPath } = querydPaths();
    if (this._watchTimer != null) clearInterval(this._watchTimer);
    if (this._server != null) this._server.close(); // stop accepting
    await this._drained(); // finish in-flight + queued
    for (const sock of this.connections) {
      try {
        sock.destroy();
      } catch {
        // ignore
      }
    }
    if (this._heartbeatTimer != null) clearInterval(this._heartbeatTimer);
    try {
      unlinkSync(socketPath);
    } catch (e) {
      if (!(e && e.code === "ENOENT")) {
        logLine({ event: "socket_unlink_failed", message: e.message });
      }
    }
    releaseQuerydLease(this._lease);
    this._lease = null;
    logLine({ event: "stopped" });
  }
}

// ---------------------------------------------------------------------------
// One-shot client helper — used by the --status CLI probe and the hermetic
// tests. This is NOT the recall client (Q2 owns that); it exists so the
// probe has zero dependencies beyond this module.
// ---------------------------------------------------------------------------

export function queryOnce(socketPath, request, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const id = request.id ?? `q-${process.pid}-${Date.now()}`;
    let settled = false;
    const finish = (err, resp) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      if (err != null) reject(err);
      else resolve(resp);
    };
    const timer = setTimeout(
      () => finish(new Error("queryd request timed out")),
      timeoutMs,
    );
    const sock = netConnect(socketPath);
    const decoder = new FrameDecoder({ maxFrameBytes: MAX_OUTBOUND_FRAME_BYTES });
    sock.once("error", (e) => finish(e));
    sock.on("close", () => finish(new Error("connection closed before response")));
    sock.once("connect", () => {
      sock.write(
        encodeFrame(
          { protocol_version: PROTOCOL_VERSION, id, ...request },
          { maxBytes: MAX_INBOUND_FRAME_BYTES },
        ),
      );
    });
    sock.on("data", (chunk) => {
      const { frames, error } = decoder.push(chunk);
      for (const frame of frames) {
        if (frame != null && frame.id === id) {
          finish(null, frame);
          return;
        }
        // hello / unsolicited frames are skipped.
      }
      if (error != null) finish(new Error(error.message));
    });
  });
}

// ---------------------------------------------------------------------------
// CLI: foreground daemon + --status probe. No stdin dependency, no launchd
// wiring here (later node).
// ---------------------------------------------------------------------------

async function statusProbeCli() {
  const { socketPath } = querydPaths();
  try {
    const resp = await queryOnce(socketPath, { type: "status" });
    if (resp && resp.ok === true) {
      process.stdout.write(`${JSON.stringify(resp)}\n`);
      return 0;
    }
    logLine({ event: "status_probe_failed", response_ok: false });
    return 1;
  } catch (e) {
    logLine({
      event: "status_probe_failed",
      code: e?.code ?? null,
      message: e?.message ?? String(e),
    });
    return 1;
  }
}

async function main(argv) {
  const args = argv.slice(2);
  if (args.includes("--status")) {
    return statusProbeCli();
  }
  const modelsArg = args.find((a) => a.startsWith("--models="));
  const modelVersions = modelsArg
    ? modelsArg
        .slice("--models=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : defaultModelVersions();

  const daemon = new Queryd({ modelVersions });
  try {
    await daemon.start();
  } catch (e) {
    logLine({
      event: "start_failed",
      code: e?.code ?? "queryd_start_failed",
      message: e?.message ?? String(e),
    });
    return 1;
  }
  logLine({
    event: "listening",
    socket: querydPaths().socketPath,
    models: modelVersions,
    pid: process.pid,
  });
  const onSignal = () => {
    daemon.stop().then(
      () => process.exit(0),
      (e) => {
        logLine({ event: "stop_failed", message: e?.message ?? String(e) });
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  daemon.ready.then(
    () => logLine({ event: "serving", state: daemon.state }),
    (e) => logLine({ event: "load_failed", message: e?.message ?? String(e) }),
  );
  return null; // keep running; the server handle holds the loop open
}

const _isMain = (() => {
  try {
    return (
      process.argv[1] != null &&
      import.meta.url === pathToFileURL(process.argv[1]).href
    );
  } catch {
    return false;
  }
})();

if (_isMain) {
  const code = await main(process.argv);
  if (typeof code === "number") process.exit(code);
}
