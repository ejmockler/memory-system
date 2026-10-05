// queryd-protocol.js — Q1 shared wire protocol for the resident query daemon
// (mcp/daemon/queryd.js) and its clients (Q2 wires lib/tools/recall.js as a
// thin client; the daemon's --status CLI probe and the hermetic tests use it
// too).
//
// Wire format: length-prefixed JSON frames over a unix stream socket.
//
//   [4-byte big-endian unsigned length N][N bytes of UTF-8 JSON]
//
// Caps (enforced at the LENGTH PREFIX, before any body is awaited):
//   - inbound  (client -> daemon): 8 MiB per frame
//   - outbound (daemon -> client): 32 MiB per frame
//
// Handshake: the daemon sends one hello frame (helloFrame()) immediately on
// connection; every client request MUST carry protocol_version ===
// PROTOCOL_VERSION and is refused with an `unsupported_version` error (and
// connection close) otherwise.
//
// Request envelope (client -> daemon):
//   { protocol_version, id, type, deadline_ms?, ...request fields }
//   - id: string|number, echoed verbatim in the response.
//   - deadline_ms: default DEFAULT_DEADLINE_MS (5000), capped at
//     MAX_DEADLINE_MS (30000). See clampDeadlineMs.
//
// Response envelope (daemon -> client):
//   { id, ok, generation, state, error?, ...result fields }
//   - generation: the S3 index-manifest generation of the model version the
//     request addressed (null for status/hello/frame-level errors).
//   - state: the daemon state at response time ("loading"|"ready"|"degraded").
//   - error: { code, message } with code one of ERROR_CODES.
//
// Malformed / oversized frame -> the peer sends ONE structured error frame
// (code "bad_frame") and closes the connection.
//
// LOGGING DISCIPLINE: this module logs NOTHING. Frames carry user content
// (query text, vectors); no platform/content string may ever reach a log
// from here.
//
// Node stdlib only. No imports at all — pure buffer/JSON code — so both the
// daemon and any client can load it without dragging in daemon-side deps.

export const PROTOCOL_VERSION = 1;

// Frame caps. The inbound cap bounds what the DAEMON accepts (requests are
// small: a query string, one query vector, or <=256 ids). The outbound cap
// bounds daemon responses (vector_fetch of 256 x 4096-dim float arrays in
// decimal JSON stays comfortably under 32 MiB — that is what sizes the
// VECTOR_FETCH_MAX_IDS batch cap below).
export const MAX_INBOUND_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_OUTBOUND_FRAME_BYTES = 32 * 1024 * 1024;

// Per-request deadline discipline (queryd enforces on queued requests at
// dequeue and on running requests at completion).
export const DEFAULT_DEADLINE_MS = 5000;
export const MAX_DEADLINE_MS = 30000;

// vector_fetch batch cap: 256 ids x 4096 dims x ~24 bytes/number of decimal
// JSON ~ 25 MiB worst case — under the 32 MiB outbound frame cap.
export const VECTOR_FETCH_MAX_IDS = 256;

// Structured error codes carried in response.error.code.
export const ERROR_CODES = Object.freeze({
  LOADING: "loading", // indices deserializing; retry after load
  DEGRADED: "degraded", // no loadable index generation; structured reason
  BUSY: "busy", // queue/in-flight caps saturated; client decides
  TIMEOUT: "timeout", // deadline_ms exceeded (queued or at completion)
  BAD_FRAME: "bad_frame", // malformed/oversized frame; connection closes
  UNSUPPORTED_VERSION: "unsupported_version", // protocol_version mismatch
  BAD_REQUEST: "bad_request", // shape/validation failure on a valid frame
});

// The daemon's request surface (Q2's needs, grounded in recall.js usage —
// searchEntities has no lib/ caller and is deliberately omitted).
export const REQUEST_TYPES = Object.freeze([
  "hello",
  "status",
  "bm25_search",
  "hnsw_search",
  "vector_fetch",
]);

/**
 * clampDeadlineMs — resolve a request's deadline_ms field to the effective
 * deadline: absent/invalid/non-positive -> DEFAULT_DEADLINE_MS; otherwise
 * floored and capped at MAX_DEADLINE_MS.
 */
export function clampDeadlineMs(deadlineMs) {
  if (
    typeof deadlineMs !== "number" ||
    !Number.isFinite(deadlineMs) ||
    deadlineMs <= 0
  ) {
    return DEFAULT_DEADLINE_MS;
  }
  return Math.min(Math.floor(deadlineMs), MAX_DEADLINE_MS);
}

/**
 * errorResponse — build the structured error envelope.
 */
export function errorResponse(id, state, generation, code, message) {
  return {
    id: id ?? null,
    ok: false,
    generation: generation ?? null,
    state: state ?? null,
    error: { code, message: typeof message === "string" ? message : String(message) },
  };
}

/**
 * helloFrame — the handshake frame the daemon sends first on every new
 * connection. Clients check protocol_version before sending requests.
 */
export function helloFrame(state) {
  return {
    id: null,
    ok: true,
    type: "hello",
    protocol_version: PROTOCOL_VERSION,
    state: state ?? null,
    generation: null,
  };
}

/**
 * encodeFrame(obj, {maxBytes}) -> Buffer
 *
 * JSON-encode `obj` and prepend the 4-byte BE length prefix. Throws an Error
 * with .code === "frame_too_large" when the JSON payload exceeds maxBytes
 * (default MAX_INBOUND_FRAME_BYTES — the client->daemon direction; the
 * daemon passes MAX_OUTBOUND_FRAME_BYTES explicitly when encoding
 * responses). The thrown message carries only sizes, never frame content.
 */
export function encodeFrame(obj, { maxBytes = MAX_INBOUND_FRAME_BYTES } = {}) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  if (json.length > maxBytes) {
    const err = new Error(
      `frame payload ${json.length} bytes exceeds cap ${maxBytes}`,
    );
    err.code = "frame_too_large";
    throw err;
  }
  const out = Buffer.allocUnsafe(4 + json.length);
  out.writeUInt32BE(json.length, 0);
  json.copy(out, 4);
  return out;
}

/**
 * FrameDecoder — incremental decoder for the stream side of the protocol.
 * Usable by both the daemon (inbound cap) and clients (outbound cap).
 *
 *   const dec = new FrameDecoder({ maxFrameBytes });
 *   socket.on("data", (chunk) => {
 *     const { frames, error } = dec.push(chunk);
 *     for (const f of frames) handle(f);
 *     if (error) { sendErrorFrame(error); socket.end(); }
 *   });
 *
 * Cap discipline: the declared length is validated as soon as the 4-byte
 * prefix is readable — BEFORE the body is buffered/awaited — so an oversized
 * declaration can never make the decoder accumulate an oversized body. After
 * the first error the decoder is dead: every subsequent push returns the
 * same error and no frames (the connection must be closed by the caller).
 *
 * Error shape: { code: "bad_frame", message } — message carries lengths and
 * parse-failure summaries only, never frame bytes.
 *
 * Reassembly cost: decoding an N-byte frame moves O(N) bytes regardless of how
 * many chunks it arrives in, and retains O(1) buffers bounded by bytes
 * RECEIVED (not by the declared length).
 */
export class FrameDecoder {
  constructor({ maxFrameBytes = MAX_INBOUND_FRAME_BYTES } = {}) {
    this._max = maxFrameBytes;
    // Two-phase reassembly, O(N) bytes moved per N-byte frame: a fixed 4-byte
    // prefix scratch, then one body buffer written at a running offset. The
    // caller's chunk is NEVER retained — bytes are copied on the way in.
    this._hdr = Buffer.alloc(4);
    this._hdrFill = 0;
    this._body = null; // null => header phase
    this._bodyFill = 0;
    this._need = 0;
    this._error = null;
  }

  _fail(message) {
    this._error = { code: ERROR_CODES.BAD_FRAME, message };
    // never retain bytes past an error — every buffer field is released
    this._hdr = null;
    this._hdrFill = 0;
    this._body = null;
    this._bodyFill = 0;
    this._need = 0;
    return this._error;
  }

  push(chunk) {
    if (this._error != null) return { frames: [], error: this._error };
    const frames = [];
    if (chunk == null || chunk.length === 0) return { frames, error: null };
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let off = 0;
    while (off < buf.length) {
      if (this._need === 0) {
        // --- prefix phase: fill the 4-byte scratch (copy, never reference) ---
        const take = Math.min(4 - this._hdrFill, buf.length - off);
        buf.copy(this._hdr, this._hdrFill, off, off + take);
        this._hdrFill += take;
        off += take;
        if (this._hdrFill < 4) break; // prefix still split across pushes
        const declared = this._hdr.readUInt32BE(0);
        this._hdrFill = 0;
        if (declared === 0) {
          return { frames, error: this._fail("zero-length frame") };
        }
        if (declared > this._max) {
          return {
            frames,
            error: this._fail(
              `declared frame length ${declared} exceeds cap ${this._max}`,
            ),
          };
        }
        // Cap-checked: only NOW is body storage allocated, and it starts small
        // and grows by doubling (never past `declared`), so a declared-but-
        // stalled frame pins bytes RECEIVED, not the declared cap.
        this._need = declared;
        this._bodyFill = 0;
        this._body = Buffer.allocUnsafe(Math.min(declared, 65536));
        continue;
      }
      // --- body phase: copy straight into the body at the running offset ---
      const take = Math.min(this._need - this._bodyFill, buf.length - off);
      if (this._bodyFill + take > this._body.length) {
        let cap = this._body.length;
        while (cap < this._bodyFill + take) cap *= 2;
        if (cap > this._need) cap = this._need;
        const grown = Buffer.allocUnsafe(cap);
        this._body.copy(grown, 0, 0, this._bodyFill);
        this._body = grown;
      }
      buf.copy(this._body, this._bodyFill, off, off + take);
      this._bodyFill += take;
      off += take;
      if (this._bodyFill < this._need) break; // body incomplete — wait
      // Frame complete: release the body reference BEFORE parsing, so a
      // malformed frame leaves no bytes reachable from the decoder.
      const body = this._body;
      const need = this._need;
      this._body = null;
      this._bodyFill = 0;
      this._need = 0;
      let parsed;
      try {
        parsed = JSON.parse(body.toString("utf8", 0, need));
      } catch (e) {
        return {
          frames,
          error: this._fail(`malformed JSON frame: ${e.message}`),
        };
      }
      frames.push(parsed);
    }
    return { frames, error: null };
  }
}
