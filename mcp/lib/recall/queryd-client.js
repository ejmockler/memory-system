// queryd-client.js — Q2 thin recall-side client for the resident query daemon
// (mcp/daemon/queryd.js). ONE lazy unix-socket connection per process; all
// wire framing is REUSED from mcp/daemon/queryd-protocol.js (encodeFrame
// inbound cap, FrameDecoder at the outbound cap, clampDeadlineMs,
// VECTOR_FETCH_MAX_IDS) — nothing of the protocol is re-implemented here.
//
// MODE RESOLUTION (env MEMORY_QUERYD=required|off|auto, default auto;
// REG: any UNRECOGNIZED non-empty value resolves to required — fail toward
// the herd ban, with one stderr warning naming the raw value), resolved ONCE
// at first index need per process and memoized for the process lifetime:
//   - required   -> "daemon": queryd or a structured failure. NEVER
//                   in-process index loading.
//   - off        -> "in-process": always today's loadIndices path.
//   - auto       -> probe the socket once (AUTO_PROBE_TIMEOUT_MS=50ms
//                   connect timeout): accepting -> "daemon" for this process
//                   lifetime; absent/dead -> "in-process", decision
//                   remembered (a daemon started later is picked up by NEW
//                   processes, not this one — deployment stays deliberate).
//
// FAILURE DISCIPLINE (the herd ban): a request gets exactly ONE reconnect
// attempt after a connection-level failure (connect refused/ENOENT, socket
// death mid-request), then throws the structured QuerydUnavailableError
// ({code:"queryd_unavailable", retryable:true}). There are no reconnect
// pools, no backoff loops, and NO in-process fallback — the caller (recall)
// degrades THAT call loudly and the next call re-probes cheaply, so a
// restarted daemon is picked up without a process restart.
//
// LOADING (operator-facing note): queryd answers queries with a structured
// `loading` error while it deserializes indices — on the production tree the
// ~1.9GB active HNSW takes double-digit seconds after a daemon (re)start or a
// generation swap. This client retries a loading response exactly ONCE after
// LOADING_RETRY_DELAY_MS (250ms) and then fails loud with reason "loading":
// expect the FIRST recall after a daemon start to degrade with
// queryd_unavailable until the load completes. That is deliberate — a
// blocking wait here would wedge every session on the daemon's cold start.
//
// DEADLINES: every request carries deadline_ms (daemon-enforced) and the same
// clampDeadlineMs bound is mirrored client-side per attempt, so a wedged
// daemon can never hang a recall past the protocol's deadline discipline.
//
// LOGGING DISCIPLINE: this module logs NOTHING (requests carry query text and
// vectors; no content may reach a log from here). Errors carry sizes/codes
// only plus transport messages.
//
// Node stdlib only.

import { connect as netConnect } from "node:net";
import process from "node:process";

import {
  ERROR_CODES as QUERYD_ERROR_CODES,
  FrameDecoder,
  MAX_OUTBOUND_FRAME_BYTES,
  PROTOCOL_VERSION,
  VECTOR_FETCH_MAX_IDS,
  clampDeadlineMs,
  encodeFrame,
} from "../../daemon/queryd-protocol.js";
// querydPaths keeps the socket-path scheme single-sourced with the daemon;
// probeSocketAlive is the same connect-probe the daemon uses for stale-socket
// recovery. queryd.js's CLI is guarded (import is side-effect-free).
import { probeSocketAlive, querydPaths } from "../../daemon/queryd.js";

// Auto-mode probe budget: one 50ms connect attempt at first index need.
const AUTO_PROBE_TIMEOUT_MS = 50;
// Per-attempt connect+hello budget. Connection failures against a dead
// socket reject in ~1ms (ENOENT/ECONNREFUSED); this bounds the wedged case.
const CONNECT_TIMEOUT_MS = 1000;
// LOADING gets exactly one retry after this delay, then the loud failure.
const LOADING_RETRY_DELAY_MS = 250;

// ---------------------------------------------------------------------------
// Structured errors.
// ---------------------------------------------------------------------------

/**
 * QuerydUnavailableError — the ONE failure shape daemon-mode callers see for
 * "queryd cannot serve this request": unreachable socket, mid-call death
 * (after the single reconnect), client/daemon deadline, loading (after the
 * single 250ms retry), degraded/busy states, protocol mismatch.
 * `{code:"queryd_unavailable", retryable:true}` is the structured degrade
 * contract recall surfaces in its ToolError details.
 */
export class QuerydUnavailableError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = "QuerydUnavailableError";
    this.code = "queryd_unavailable";
    this.retryable = true;
    // Machine-readable failure class: "unreachable" | "timeout" | one of the
    // daemon ERROR_CODES ("loading", "degraded", "busy", ...).
    this.reason = typeof opts.reason === "string" ? opts.reason : "unreachable";
    if (Number.isInteger(opts.attempts)) this.attempts = opts.attempts;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

/**
 * QuerydBadRequestError — the daemon refused the request shape (most
 * relevantly: an unknown model_version). NOT an availability failure; recall
 * maps it to the empty-index shape so its absent-tree fallback branches run
 * unchanged.
 */
export class QuerydBadRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = "QuerydBadRequestError";
    this.code = "queryd_bad_request";
    this.retryable = false;
  }
}

// ---------------------------------------------------------------------------
// The client — one lazy connection, request/response correlation by id.
// ---------------------------------------------------------------------------

export class QuerydClient {
  constructor({ socketPath } = {}) {
    this.socketPath =
      typeof socketPath === "string" && socketPath.length > 0
        ? socketPath
        : querydPaths().socketPath;
    this._conn = null; // {sock, decoder, pending: Map<id,{resolve,reject}>}
    this._connPromise = null; // in-flight connect (dedupes concurrent callers)
    this._nextId = 1;
  }

  close() {
    const conn = this._conn;
    this._conn = null;
    this._connPromise = null;
    if (conn != null) {
      try {
        conn.sock.destroy();
      } catch {
        // ignore
      }
    }
  }

  // Establish the connection and complete the hello-first handshake: the
  // daemon sends one hello frame immediately; we verify protocol_version
  // before the connection is usable. Rejections carry
  // code "queryd_connect_failed" (the reconnect-eligible class).
  _connect() {
    return new Promise((resolve, reject) => {
      const sock = netConnect(this.socketPath);
      // An idle daemon connection must never hold a client process open.
      sock.unref();
      const conn = {
        sock,
        decoder: new FrameDecoder({ maxFrameBytes: MAX_OUTBOUND_FRAME_BYTES }),
        pending: new Map(),
        helloSeen: false,
      };
      let settled = false;
      const failConnect = (cause) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        try {
          sock.destroy();
        } catch {
          // ignore
        }
        const err = new Error(
          `queryd connect failed (${this.socketPath}): ${
            cause && cause.message ? cause.message : String(cause)
          }`,
        );
        err.code = "queryd_connect_failed";
        err.cause = cause;
        reject(err);
      };
      const connectTimer = setTimeout(
        () => failConnect(new Error(`connect/hello timeout after ${CONNECT_TIMEOUT_MS}ms`)),
        CONNECT_TIMEOUT_MS,
      );
      sock.on("error", (e) => {
        failConnect(e);
        this._teardown(conn, e);
      });
      sock.on("close", () => {
        failConnect(new Error("socket closed before hello"));
        this._teardown(conn, new Error("queryd connection closed"));
      });
      sock.on("data", (chunk) => {
        const { frames, error } = conn.decoder.push(chunk);
        for (const frame of frames) {
          if (!conn.helloSeen) {
            conn.helloSeen = true;
            if (
              frame == null ||
              frame.type !== "hello" ||
              frame.protocol_version !== PROTOCOL_VERSION
            ) {
              failConnect(
                new Error(
                  `handshake refused: expected hello with protocol_version ${PROTOCOL_VERSION}`,
                ),
              );
              return;
            }
            if (!settled) {
              settled = true;
              clearTimeout(connectTimer);
              resolve(conn);
            }
            continue;
          }
          this._deliver(conn, frame);
        }
        if (error != null) {
          // Malformed/oversized frame from the daemon: the decoder is dead —
          // drop the connection (pending requests reject via teardown).
          try {
            sock.destroy();
          } catch {
            // ignore
          }
        }
      });
    });
  }

  _teardown(conn, cause) {
    if (this._conn === conn) {
      this._conn = null;
      this._connPromise = null;
    }
    const pending = conn.pending;
    conn.pending = new Map();
    for (const [, entry] of pending) {
      const err = new Error(
        `queryd connection lost before response: ${
          cause && cause.message ? cause.message : String(cause)
        }`,
      );
      err.code = "queryd_connection_lost";
      entry.reject(err);
    }
  }

  _deliver(conn, frame) {
    const id = frame != null && typeof frame === "object" ? frame.id : null;
    if (id == null || !conn.pending.has(id)) return; // unsolicited — ignore
    const entry = conn.pending.get(id);
    conn.pending.delete(id);
    entry.resolve(frame);
  }

  async _ensureConn() {
    if (this._conn != null) return this._conn;
    if (this._connPromise == null) {
      this._connPromise = this._connect().then(
        (conn) => {
          this._connPromise = null;
          this._conn = conn;
          return conn;
        },
        (err) => {
          this._connPromise = null;
          throw err;
        },
      );
    }
    return this._connPromise;
  }

  // One send attempt: connect if needed, write the frame, await the
  // correlated response or the mirrored client-side deadline.
  async _sendOnce(fields, deadlineMs) {
    const conn = await this._ensureConn();
    const id = `q2c-${process.pid}-${this._nextId++}`;
    const frame = {
      protocol_version: PROTOCOL_VERSION,
      id,
      deadline_ms: deadlineMs,
      ...fields,
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        const err = new Error(
          `queryd request exceeded client-side deadline (${deadlineMs}ms)`,
        );
        err.code = "queryd_client_deadline";
        reject(err);
      }, deadlineMs);
      conn.pending.set(id, {
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      let buf;
      try {
        buf = encodeFrame(frame); // inbound (client->daemon) cap enforced here
      } catch (e) {
        clearTimeout(timer);
        conn.pending.delete(id);
        // Oversized request frame is a caller-shape bug, not availability.
        reject(new QuerydBadRequestError(e.message));
        return;
      }
      conn.sock.write(buf);
    });
  }

  /**
   * request(fields, {deadlineMs}) -> ok response envelope.
   *
   * Budget per request: ONE reconnect after a connection-level failure and
   * ONE 250ms retry after a `loading` response; anything else (or a second
   * failure) throws QuerydUnavailableError. BAD_REQUEST responses throw
   * QuerydBadRequestError. `deadlineMs` is clamped by the protocol's
   * clampDeadlineMs, sent to the daemon, and mirrored client-side.
   */
  async request(fields, { deadlineMs } = {}) {
    const deadline = clampDeadlineMs(deadlineMs);
    let reconnected = false;
    let loadingRetried = false;
    let attempts = 0;
    for (;;) {
      attempts += 1;
      let resp;
      try {
        resp = await this._sendOnce(fields, deadline);
      } catch (err) {
        if (err instanceof QuerydBadRequestError) throw err;
        const connectionLevel =
          err != null &&
          (err.code === "queryd_connect_failed" ||
            err.code === "queryd_connection_lost");
        if (connectionLevel && !reconnected) {
          reconnected = true; // exactly ONE reconnect attempt per request
          continue;
        }
        throw new QuerydUnavailableError(
          `queryd unreachable at ${this.socketPath}: ${
            err && err.message ? err.message : String(err)
          }`,
          {
            reason:
              err != null && err.code === "queryd_client_deadline"
                ? "timeout"
                : "unreachable",
            attempts,
            cause: err,
          },
        );
      }
      if (resp != null && resp.ok === true) return resp;
      const code =
        resp != null && resp.error != null && typeof resp.error.code === "string"
          ? resp.error.code
          : "malformed_response";
      if (code === QUERYD_ERROR_CODES.LOADING && !loadingRetried) {
        loadingRetried = true; // exactly ONE loading retry per request
        await new Promise((r) => setTimeout(r, LOADING_RETRY_DELAY_MS));
        continue;
      }
      if (code === QUERYD_ERROR_CODES.BAD_REQUEST) {
        throw new QuerydBadRequestError(
          resp.error && typeof resp.error.message === "string"
            ? resp.error.message
            : "bad request",
        );
      }
      // loading (post-retry), degraded, busy, timeout, unsupported_version,
      // bad_frame, malformed -> the one loud structured failure.
      throw new QuerydUnavailableError(
        `queryd cannot serve (${code}): ${
          resp != null && resp.error != null ? resp.error.message : "no error body"
        }`,
        { reason: code, attempts },
      );
    }
  }

  /** status() -> the daemon's status envelope (state + per-model sizes). */
  status(opts = {}) {
    return this.request({ type: "status" }, opts);
  }

  /** bm25_search over the daemon-resident index. Raw query string through. */
  bm25Search(modelVersion, queryText, k, opts = {}) {
    return this.request(
      {
        type: "bm25_search",
        model_version: modelVersion,
        query_text: queryText,
        k,
      },
      opts,
    );
  }

  /** hnsw_search over the daemon-resident index. */
  hnswSearch(modelVersion, vector, k, opts = {}) {
    return this.request(
      {
        type: "hnsw_search",
        model_version: modelVersion,
        vector,
        k,
      },
      opts,
    );
  }

  /**
   * vectorFetch(modelVersion, ids) -> { byId: Map<id, number[]|null>,
   * generation }. Ids are deduped and CHUNKED at VECTOR_FETCH_MAX_IDS (256)
   * per frame — a single over-cap frame would be refused by the daemon.
   * Unknown/tombstoned ids resolve to null (the daemon's structured nulls).
   */
  async vectorFetch(modelVersion, ids, opts = {}) {
    const clean = [];
    const seen = new Set();
    for (const id of Array.isArray(ids) ? ids : []) {
      if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
      seen.add(id);
      clean.push(id);
    }
    const byId = new Map();
    let generation = null;
    if (clean.length === 0) return { byId, generation };
    const chunks = [];
    for (let i = 0; i < clean.length; i += VECTOR_FETCH_MAX_IDS) {
      chunks.push(clean.slice(i, i + VECTOR_FETCH_MAX_IDS));
    }
    const responses = await Promise.all(
      chunks.map((chunk) =>
        this.request(
          { type: "vector_fetch", model_version: modelVersion, ids: chunk },
          opts,
        ),
      ),
    );
    for (const resp of responses) {
      if (generation == null && resp.generation != null) {
        generation = resp.generation;
      }
      for (const v of Array.isArray(resp.vectors) ? resp.vectors : []) {
        if (v != null && typeof v.id === "string") {
          byId.set(v.id, Array.isArray(v.vector) ? v.vector : null);
        }
      }
    }
    return { byId, generation };
  }
}

// ---------------------------------------------------------------------------
// Mode resolution + the per-process shared client.
// ---------------------------------------------------------------------------

let _resolvedMode = null; // null | "daemon" | "in-process"
let _sharedClient = null;

export function _readModeEnv() {
  const raw =
    typeof process.env.MEMORY_QUERYD === "string"
      ? process.env.MEMORY_QUERYD.trim().toLowerCase()
      : "";
  if (raw === "required" || raw === "off") return raw;
  if (raw === "" || raw === "auto") return "auto";
  // REG (memperf) — config hardening: an UNRECOGNIZED value FAILS TOWARD the
  // herd ban ("required"), never silently auto. Pre-REG a typo like
  // MEMORY_QUERYD=requird resolved to auto: with no socket present every
  // recall herd-loaded the multi-GB indices in-process — the exact failure
  // mode the deployment set the env var to ban. One stderr warning names the
  // raw value (memoized mode resolution ⇒ once per process). This is the one
  // sanctioned log line in this module (see LOGGING DISCIPLINE above): it
  // carries only the env value — never query text or vectors.
  console.error(
    `queryd-client: unrecognized MEMORY_QUERYD value ${JSON.stringify(
      process.env.MEMORY_QUERYD,
    )}; treating as "required" (fail toward the herd ban; expected required|off|auto)`,
  );
  return "required";
}

/**
 * resolveQuerydMode() -> "daemon" | "in-process", resolved once at first
 * index need per process and memoized for the process lifetime (see module
 * header for the required/off/auto semantics).
 */
export async function resolveQuerydMode() {
  if (_resolvedMode != null) return _resolvedMode;
  const mode = _readModeEnv();
  if (mode === "off") {
    _resolvedMode = "in-process";
  } else if (mode === "required") {
    _resolvedMode = "daemon";
  } else {
    const alive = await probeSocketAlive(
      querydPaths().socketPath,
      AUTO_PROBE_TIMEOUT_MS,
    );
    _resolvedMode = alive ? "daemon" : "in-process";
  }
  return _resolvedMode;
}

/** The one lazy client per process (no reconnect pools). */
export function getQuerydClient() {
  if (_sharedClient == null) _sharedClient = new QuerydClient();
  return _sharedClient;
}

// Test-only escape hatch (codebase convention, cf. index-cache._resetCaches):
// clears the memoized mode + shared client so hermetic tests can flip
// MEMORY_QUERYD / daemon lifecycles within one process. Production code
// never calls this — the memoized decision is the deployment contract.
export function _resetQuerydForTest() {
  _resolvedMode = null;
  if (_sharedClient != null) {
    try {
      _sharedClient.close();
    } catch {
      // ignore
    }
  }
  _sharedClient = null;
}
