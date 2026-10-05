#!/usr/bin/env python3
# embed_server.py — persistent local embedding server for the memory-system.
#
# Holds the embedding model (default Qwen3-Embedding-8B, unquantized) warm on
# the local accelerator (Apple MPS or CUDA in fp16; CPU fallback in fp32) and
# answers batched embed requests over localhost. The node-side embed worker
# calls this instead of Gemini — same {texts -> L2-normalized vectors}
# contract, but local, unmetered, private (operator content never leaves the
# machine), and ~orders of magnitude higher throughput than free-tier Gemini.
#
# Protocol (JSON over HTTP):
#   POST /embed   {"texts": [...], "is_query": false, "dim": 768|3072|4096}
#                 -> {"embeddings": [[...]], "model_version": "...", "dim": N}
#   GET  /health  -> {"ok": true, "model": "...", "device": "mps|cuda|cpu",
#                     "native_dim": N}
#                    (+ additive counters: gpu_calls, rejected_429, inflight,
#                     served, draining — consumers only require ok:true)
#
# Design:
#   - Model loaded ONCE at startup (load cost ~10-30s); subsequent requests are
#     warm GPU forward passes. The load lives in _load_model() (called from
#     main) so tests can swap in a fake model via EMBED_FAKE_MODEL=1.
#   - normalize_embeddings=True always (the HNSW/cosine pipeline wants unit norm).
#   - MRL truncation honored per-request via `dim` (Qwen3-Embedding is Matryoshka):
#     a 768-dim view feeds the existing HNSW; the full vector can be stored.
#   - Query vs document asymmetry: is_query=true uses the retrieval instruction
#     prompt (Qwen3-Embedding's prompt_name="query").
#
# Model / device (env; defaults reproduce the Apple Silicon production tier):
#   - EMBED_MODEL (Qwen/Qwen3-Embedding-8B) / EMBED_MODEL_VERSION: the model id
#     and the version string stamped on every response. The Node client
#     requires 4096-dim vectors, so a smaller model needs Node-side changes.
#   - EMBED_DEVICE (unset = auto): torch device for the model. Auto-detect
#     picks mps, then cuda, then cpu. dtype is fp16 on mps/cuda, fp32 on cpu.
#
# Bounds (all env-tunable; defaults are production values):
#   - EMBED_MAX_BODY_BYTES (8MB): Content-Length above the cap -> 413 without
#     reading the body; missing/non-numeric Content-Length -> 400.
#   - EMBED_MAX_INFLIGHT (8): admission control over validated /embed requests
#     waiting on or holding the GPU lock; overflow -> immediate 429, so
#     ThreadingHTTPServer can no longer stack unbounded GPU-blocked threads.
#   - EMBED_REQUEST_DEADLINE_MS (55000, inside the node client's 60s abort) and
#     the optional X-Embed-Deadline-Ms request header: a request whose deadline
#     expires — or whose client hung up — while queued NEVER reaches encode.
#   - EMBED_MPS_EMPTY_CACHE_EVERY (1): torch.mps.empty_cache() after every Nth
#     encode (0 disables) as the measured MPS-leak mitigation.
#   - SIGTERM/SIGINT: graceful drain — stop accepting, 503 {"error":"draining"}
#     to queued-not-yet-on-GPU work, let the in-flight encode finish, exit 0
#     within EMBED_DRAIN_TIMEOUT_S (20). launchd KeepAlive absorbs the restart.
#   - EMBED_RECYCLE_AFTER_REQUESTS (0 = disabled): optional self-recycle through
#     the same drain path after N served /embed requests.
#
# Test seam: EMBED_FAKE_MODEL=1 skips SentenceTransformer/torch entirely and
# installs a stub model (encode sleeps EMBED_FAKE_LATENCY_MS, returns
# deterministic L2-unit float32 vectors of EMBED_FAKE_DIM, default 8). Every
# handler/lock/queue/drain code path is identical to production — only the
# model object differs. With the flag unset, wire behavior is unchanged.

import json, os, select, signal, socket, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

MODEL_ID = os.environ.get("EMBED_MODEL", "Qwen/Qwen3-Embedding-8B")
MODEL_VERSION = os.environ.get("EMBED_MODEL_VERSION", "qwen3-embedding-8b-fp16")
HOST = os.environ.get("EMBED_HOST", "127.0.0.1")
PORT = int(os.environ.get("EMBED_PORT", "8359"))
DEFAULT_DIM = int(os.environ.get("EMBED_DEFAULT_DIM", "0"))  # 0 = native
# Requested torch device ("" = auto-detect). Read here WITHOUT importing torch:
# resolution happens in _load_model() so the fake-model seam stays torch-free.
DEVICE_REQUEST = os.environ.get("EMBED_DEVICE", "").strip().lower()

# HARD sequence-length cap. Qwen3-Embedding-8B advertises a 40,960-token context,
# but a single multi-thousand-token sequence forces an attention/activation
# buffer the MPS allocator rejects ("Invalid buffer size: ... GiB") and, worse,
# wedges the GPU under _LOCK so every later request times out. The node-side
# chunker keeps windows small, but the SERVER must also self-protect: truncate at
# a length proven to fit on this M-series GPU so no request can ever wedge it.
# 2048 tokens (~8K chars) embeds fast and is far inside the safe envelope.
MAX_SEQ_TOKENS = int(os.environ.get("EMBED_MAX_SEQ_TOKENS", "2048"))

# --- Bounds / drain knobs (defaults = production values) ----------------------
MAX_BODY_BYTES = int(os.environ.get("EMBED_MAX_BODY_BYTES", "8388608"))  # 8MB
MAX_INFLIGHT = int(os.environ.get("EMBED_MAX_INFLIGHT", "8"))
REQUEST_DEADLINE_MS = int(os.environ.get("EMBED_REQUEST_DEADLINE_MS", "55000"))
MPS_EMPTY_CACHE_EVERY = int(os.environ.get("EMBED_MPS_EMPTY_CACHE_EVERY", "1"))
# Padded-token budget for ONE forward pass, and the hard batch ceiling.
# batch_size is derived per request as clamp(MAX_BATCH_TOKENS / longest_est,
# 1, MAX_BATCH_SIZE) — see _batch_size_for. 16384 keeps a worst-case
# all-2048-token batch at 8 wide (~8x less activation area than the old fixed
# 64) while leaving the p50 ~13-token case at the full ceiling.
MAX_BATCH_TOKENS = int(os.environ.get("EMBED_MAX_BATCH_TOKENS", "16384"))
MAX_BATCH_SIZE = int(os.environ.get("EMBED_MAX_BATCH_SIZE", "64"))
DRAIN_TIMEOUT_S = float(os.environ.get("EMBED_DRAIN_TIMEOUT_S", "20"))
RECYCLE_AFTER_REQUESTS = int(os.environ.get("EMBED_RECYCLE_AFTER_REQUESTS", "0"))

# --- Fake-model test seam ------------------------------------------------------
FAKE_MODEL = os.environ.get("EMBED_FAKE_MODEL", "") == "1"
FAKE_LATENCY_MS = float(os.environ.get("EMBED_FAKE_LATENCY_MS", "0"))
FAKE_DIM = int(os.environ.get("EMBED_FAKE_DIM", "8"))
# E1 zero-norm-embedding-root-cause: reproduce the measured BATCH-ONLY fault
# class (0/620 production events had items=1). When the marker is a substring
# of a text AND the encode call carries >= 2 texts, _FakeModel returns a NaN
# row for it; sent alone the same text embeds normally — exactly what the
# fp16 MPS batched forward pass does. EMBED_FAKE_NAN_ALWAYS=1 makes the
# single-row re-encode fail too (the unrecovered path).
FAKE_NAN_MARKER = os.environ.get("EMBED_FAKE_NAN_MARKER", "\x00NAN")
FAKE_NAN_ALWAYS = os.environ.get("EMBED_FAKE_NAN_ALWAYS", "") == "1"
# The second measured shape of the same fault: a FINITE fp16 garbage row
# (|x| > 256 — the numpy overflow warnings in logs/embed-server.stderr).
# Same batch-only gating; EMBED_FAKE_NAN_ALWAYS also makes it persist alone.
FAKE_GARBAGE_MARKER = os.environ.get("EMBED_FAKE_GARBAGE_MARKER", "\x00GARBAGE")
# Degenerate-row detection + recovery bounds (see _encode_locked). The model
# is called with normalize_embeddings=True, so every healthy row has L2 norm
# 1.0 up to fp16 rounding (~1e-3); a row whose norm is off by more than the
# tolerance is garbage, whether or not it is finite.
DEGENERATE_NORM_TOL = float(os.environ.get("EMBED_DEGENERATE_NORM_TOL", "0.05"))
# Serial single-row re-encodes allowed per request (all under _LOCK); rows
# beyond the cap leave as unrecovered all-zero. 0 disables recovery.
DEGENERATE_RETRY_MAX = int(os.environ.get("EMBED_DEGENERATE_RETRY_MAX", "8"))

# Serialize GPU access: MPS is single-context; one forward pass at a time.
_LOCK = threading.Lock()

# Model globals — populated by _load_model() before the server starts.
_MODEL = None
NATIVE_DIM = 0
_TORCH = None  # torch module in real mode; None in fake mode.
_DEVICE = ""   # resolved device string, reported on /health.

# Counters (guarded by _CTR_LOCK, never by _LOCK — /health must stay lock-free
# with respect to the GPU lock so it answers instantly under load).
_CTR_LOCK = threading.Lock()
_INFLIGHT = 0       # validated /embed requests waiting on or holding _LOCK
_GPU_CALLS = 0      # encode() invocations (the additive deadline-skip proof)
_REJECTED_429 = 0   # admission-control rejections
_SERVED = 0         # 200 /embed responses
_SKIPPED_GONE = 0   # admitted requests skipped because the client hung up
# E1 zero-norm-embedding-root-cause: rows of a batched encode that came back
# non-finite or all-zero (the fp16 MPS batch-path fault), how many a single-
# row re-encode repaired, and how many stayed degenerate (returned all-zero).
_DEGENERATE_ROWS = 0
_DEGENERATE_RECOVERED = 0
_DEGENERATE_UNRECOVERED = 0

_DRAINING = threading.Event()
_SRV = None  # the ThreadingHTTPServer, so drain can stop it from any thread.


class _FakeModel:
    """EMBED_FAKE_MODEL=1 stub. Mimics the SentenceTransformer surface the
    server uses (encode / get_sentence_embedding_dimension / max_seq_length
    assignment) so every handler/lock/queue/drain path runs unmodified.
    encode() sleeps EMBED_FAKE_LATENCY_MS to simulate GPU occupancy and returns
    deterministic (sha256-derived) L2-unit float32 vectors of EMBED_FAKE_DIM."""

    def __init__(self, dim, latency_ms):
        self._dim = dim
        self._latency_ms = latency_ms
        self.max_seq_length = None  # assignable, like the real model

    def get_sentence_embedding_dimension(self):
        return self._dim

    def encode(self, texts, **kwargs):
        import hashlib
        if self._latency_ms > 0:
            time.sleep(self._latency_ms / 1000.0)
        out = np.zeros((len(texts), self._dim), dtype=np.float32)
        for i, t in enumerate(texts):
            d = hashlib.sha256(t.encode("utf-8")).digest()
            raw = (d * (self._dim // len(d) + 1))[: self._dim]
            out[i] = np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 127.5
        norms = np.linalg.norm(out, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        out = (out / norms).astype(np.float32)
        # E1 batch-only NaN seam (see FAKE_NAN_MARKER above).
        if FAKE_NAN_MARKER:
            for i, t in enumerate(texts):
                if FAKE_NAN_MARKER in t and (len(texts) >= 2 or FAKE_NAN_ALWAYS):
                    out[i] = np.nan
        # E1 batch-only finite-garbage seam (see FAKE_GARBAGE_MARKER above).
        if FAKE_GARBAGE_MARKER:
            for i, t in enumerate(texts):
                if FAKE_GARBAGE_MARKER in t and (len(texts) >= 2 or FAKE_NAN_ALWAYS):
                    out[i] = 300.0
        return out


def _resolve_device(torch, requested):
    """Device for the model: the EMBED_DEVICE request if set, else the best
    available backend (mps, then cuda, then cpu). Takes the torch module as an
    argument so nothing here forces a torch import at module load."""
    if requested:
        return requested
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def _load_model():
    """Load the model (real or fake) and apply the sequence cap. Called from
    main() before the server starts — no module-level load, so tests can spawn
    the server without touching SentenceTransformer/torch at all."""
    global _MODEL, NATIVE_DIM, _TORCH, _DEVICE
    _t0 = time.time()
    if FAKE_MODEL:
        print(f"embed_server: loading FAKE model (EMBED_FAKE_MODEL=1, dim={FAKE_DIM}, "
              f"latency={FAKE_LATENCY_MS}ms) ...", flush=True)
        _MODEL = _FakeModel(FAKE_DIM, FAKE_LATENCY_MS)
        # No torch in fake mode: report the request, or the production default.
        _DEVICE = DEVICE_REQUEST or "mps"
    else:
        import torch
        from sentence_transformers import SentenceTransformer
        _TORCH = torch
        _DEVICE = _resolve_device(torch, DEVICE_REQUEST)
        # fp16 on a GPU backend (the production tier); fp32 on CPU, where half
        # precision is slow and poorly supported.
        _half = _DEVICE.startswith(("mps", "cuda"))
        _dtype = torch.float16 if _half else torch.float32
        print(f"embed_server: loading {MODEL_ID} "
              f"({'fp16' if _half else 'fp32'}, {_DEVICE}) ...", flush=True)
        _MODEL = SentenceTransformer(
            MODEL_ID,
            model_kwargs={"torch_dtype": _dtype},
            tokenizer_kwargs={"padding_side": "left"},
            device=_DEVICE,
        )
    NATIVE_DIM = _MODEL.get_sentence_embedding_dimension()
    try:
        _MODEL.max_seq_length = MAX_SEQ_TOKENS
        if hasattr(_MODEL, "tokenizer") and _MODEL.tokenizer is not None:
            _MODEL.tokenizer.model_max_length = MAX_SEQ_TOKENS
        print(f"embed_server: max_seq_length capped at {MAX_SEQ_TOKENS} tokens", flush=True)
    except Exception as _e:
        print(f"embed_server: WARN could not set max_seq_length: {_e}", flush=True)
    print(f"embed_server: ready in {time.time()-_t0:.1f}s | native_dim={NATIVE_DIM} | "
          f"listening http://{HOST}:{PORT}", flush=True)


def _maybe_empty_mps_cache(gpu_calls):
    """Release MPS cached allocations every EMBED_MPS_EMPTY_CACHE_EVERY encodes.
    Runs UNDER _LOCK, immediately after encode: MPS is single-context and the
    next forward pass cannot start until the lock is released, so the release
    can never race an in-flight kernel. Real mode only; a failed release must
    never fail the request."""
    if FAKE_MODEL or MPS_EMPTY_CACHE_EVERY <= 0:
        return
    if gpu_calls % MPS_EMPTY_CACHE_EVERY != 0:
        return
    try:
        if _TORCH is not None and _TORCH.backends.mps.is_available():
            _TORCH.mps.empty_cache()
    except Exception:
        pass


def _batch_size_for(texts):
    """Token-aware batch size: bound the PADDED TOKEN AREA of one forward pass.

    The fixed batch_size=64 was the real memory problem. sentence-transformers
    pads every text in a batch to that batch's longest member, so the activation
    footprint of a forward pass scales with batch_size * longest_sequence, not
    with the average. At the 2048-token cap a full 64-wide batch is ~131k padded
    tokens in one pass, which on MPS produced transient spikes measured at 47,
    67, 71, 77 GB — and 116/149 GB before the watchdog killed it. The reembed
    script documents the same effect from the caller side: "any sustained long
    batch inflates MPS ~30GB/min".

    This is a spike inside ONE encode, not a slow leak, which is why
    EMBED_RECYCLE_AFTER_REQUESTS (a per-request-count valve) could never fix it:
    the process blew past 45 GB at request 44 of 128.

    NOT a cap on what can be embedded. Every text still gets embedded, at full
    length up to MAX_SEQ_TOKENS. Only the WIDTH of a single forward pass adapts:
    the corpus p50 is ~13 tokens, so ordinary batches stay at the full 64 and
    throughput is unchanged; only genuinely long batches narrow, trading a few
    extra passes for a bounded peak.

    ~4 chars/token is a deliberately cheap estimate — tokenizing here would
    double the tokenization cost of every request to save nothing.
    """
    if not texts:
        return 1
    longest_chars = max(len(t) for t in texts)
    est_tokens = min(MAX_SEQ_TOKENS, max(1, longest_chars // 4))
    by_budget = max(1, MAX_BATCH_TOKENS // est_tokens)
    return max(1, min(len(texts), MAX_BATCH_SIZE, by_budget))


def _encode_locked(texts, is_query, dim):
    """The GPU section. Caller MUST hold _LOCK. Increments _GPU_CALLS (the
    counter proving deadline-expired / abandoned work never got here)."""
    global _GPU_CALLS, _DEGENERATE_ROWS, _DEGENERATE_RECOVERED, _DEGENERATE_UNRECOVERED
    kwargs = dict(batch_size=_batch_size_for(texts), normalize_embeddings=True,
                  convert_to_numpy=True)
    if is_query:
        kwargs["prompt_name"] = "query"
    with _CTR_LOCK:
        _GPU_CALLS += 1
        calls = _GPU_CALLS
    emb = _MODEL.encode(texts, **kwargs)
    _maybe_empty_mps_cache(calls)
    # E1 zero-norm-embedding-root-cause. Cast to float32 BEFORE any norm: the
    # model hands back float16, and np.linalg.norm on an un-normalized fp16
    # garbage row overflows (the "overflow encountered in multiply"
    # RuntimeWarnings in logs/embed-server.stderr came from the norm below).
    emb = np.asarray(emb, dtype=np.float32)
    # DEGENERATE-ROW RECOVERY. The batched fp16 forward pass on MPS sometimes
    # returns ONE row of a multi-row batch as NaN/inf/all-zero OR as finite
    # garbage (|x| > 256, norm far from the 1.0 that normalize_embeddings=True
    # guarantees); the same text encoded alone has never done so (measured: 0
    # of 620 production events had a single-item batch). So re-encode each bad
    # row by itself, with the same kwargs, and swap it in. A row that is still
    # degenerate — or never re-encoded (retry cap, whole-batch fault) — is
    # zeroed and falls through to the NaN guard below, leaving as finite
    # all-zeros: the wire contract is unchanged, only the counters + one
    # stderr line per event make the residual visible on /health.
    #
    # Bounds: a whole-batch failure (every row bad, >= 2 rows) is a GPU fault,
    # not the one-row class — skip recovery entirely rather than serially
    # re-encoding N rows under _LOCK on a wedged device; otherwise at most
    # DEGENERATE_RETRY_MAX single-row re-encodes per request, each counted in
    # _GPU_CALLS and followed by the same MPS-cache hygiene as the primary
    # encode.
    row_norms = np.linalg.norm(emb, axis=1)
    bad = np.where(~np.isfinite(emb).all(axis=1) | (row_norms == 0)
                   | (np.abs(row_norms - 1.0) > DEGENERATE_NORM_TOL))[0]
    whole_batch = len(bad) == len(texts) and len(texts) >= 2
    if whole_batch:
        print(f"embed_server: degenerate whole-batch batch={len(texts)} — skipping recovery",
              file=sys.stderr, flush=True)
    retries = 0
    for i in bad:
        i = int(i)
        ok = False
        tried = False
        if len(texts) >= 2 and not whole_batch and retries < DEGENERATE_RETRY_MAX:
            tried = True
            retries += 1
            try:
                with _CTR_LOCK:
                    _GPU_CALLS += 1
                    rcalls = _GPU_CALLS
                retry = _MODEL.encode([texts[i]], **{**kwargs, "batch_size": 1})
                _maybe_empty_mps_cache(rcalls)
                retry = np.asarray(retry, dtype=np.float32)
                row = retry[0] if retry.ndim == 2 and retry.shape[0] == 1 else None
                if (row is not None and row.shape == emb[i].shape
                        and np.isfinite(row).all()
                        and abs(float(np.linalg.norm(row)) - 1.0) <= DEGENERATE_NORM_TOL):
                    emb[i] = row
                    ok = True
            except Exception as e:  # a failed re-encode is an unrecovered row, not a 500
                print(f"embed_server: degenerate row re-encode raised: {e!r}",
                      file=sys.stderr, flush=True)
        if not ok:
            # Finite garbage would otherwise renormalize into a plausible unit
            # vector below; zero it so it leaves as the contract's all-zero row.
            emb[i] = 0.0
        with _CTR_LOCK:
            _DEGENERATE_ROWS += 1
            if ok:
                _DEGENERATE_RECOVERED += 1
            else:
                _DEGENERATE_UNRECOVERED += 1
        print(f"embed_server: degenerate row idx={i} len={len(texts[i])} "
              f"batch={len(texts)} recovered={ok} retried={tried}",
              file=sys.stderr, flush=True)
    if dim and dim < emb.shape[1]:
        # Matryoshka truncate.
        emb = emb[:, :dim]
    # NaN GUARD (always, both paths): a degenerate input (empty / all-special-
    # token) yields a zero vector, and normalize_embeddings then divides by zero
    # -> NaN. Python's json.dumps emits literal "NaN" (invalid JSON), which
    # crashes the Node client's res.json(). Scrub non-finite values, then
    # renormalize with a zero-guard so every returned vector is finite AND unit-
    # norm (a truly-degenerate row stays all-zero, never NaN).
    emb = np.nan_to_num(emb, nan=0.0, posinf=0.0, neginf=0.0)
    norms = np.linalg.norm(emb, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    emb = emb / norms
    return emb.astype(np.float32).tolist()


def _begin_drain(reason):
    """Idempotent graceful-drain trigger, callable from any thread (signal
    handler, recycle path). Sets the draining flag (queued-not-on-GPU requests
    see it and 503), then stops the accept loop from a helper thread —
    srv.shutdown() blocks until serve_forever exits, so it must never run on
    the thread executing serve_forever (the signal handler runs there)."""
    global _SRV
    if _DRAINING.is_set():
        return
    _DRAINING.set()
    print(f"embed_server: drain started ({reason})", flush=True)
    srv = _SRV
    if srv is not None:
        def _stop():
            srv.shutdown()
            try:
                srv.server_close()  # close the listener: new connects are refused
            except Exception:
                pass
        threading.Thread(target=_stop, daemon=True).start()


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        # allow_nan=False is a hard tripwire: with the _embed NaN-guard upstream
        # a non-finite value should never reach here; if one ever does, fail the
        # request loudly instead of emitting invalid "NaN" tokens onto the wire.
        body = json.dumps(obj, allow_nan=False).encode("utf-8")
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # The client gave up (e.g. a slow embed exceeded its timeout) and
            # closed the socket before we finished writing. This is BENIGN: the
            # node-side worker re-enqueues a dropped item. Swallow it quietly so a
            # single timed-out request can't spew a traceback per call and wedge
            # the stderr log — the exact spam that got this daemon unloaded.
            pass

    def log_message(self, *a):
        pass  # quiet; the node side logs

    def _client_gone(self):
        """Best-effort disconnect probe: a readable socket whose MSG_PEEK recv
        returns b'' is a closed peer (the client sent its full request already,
        so pending readable bytes normally mean EOF). Any probe error counts as
        gone — writing to it would only hit the BrokenPipe swallow anyway."""
        try:
            r, _, _ = select.select([self.connection], [], [], 0)
            if not r:
                return False
            return self.connection.recv(1, socket.MSG_PEEK) == b""
        except (OSError, ValueError):
            return True

    def do_GET(self):
        if self.path == "/health":
            # Lock-free w.r.t. _LOCK (only the cheap counter mutex) so /health
            # answers instantly even while an encode holds the GPU.
            with _CTR_LOCK:
                counters = {"gpu_calls": _GPU_CALLS, "rejected_429": _REJECTED_429,
                            "inflight": _INFLIGHT, "served": _SERVED,
                            "skipped_client_gone": _SKIPPED_GONE,
                            # E1: additive keys, _CTR_LOCK only (never _LOCK).
                            "degenerate_rows": _DEGENERATE_ROWS,
                            "degenerate_recovered": _DEGENERATE_RECOVERED,
                            "degenerate_unrecovered": _DEGENERATE_UNRECOVERED}
            resp = {"ok": True, "model": MODEL_ID,
                    "model_version": MODEL_VERSION,
                    "device": _DEVICE, "native_dim": NATIVE_DIM,
                    "draining": _DRAINING.is_set()}
            resp.update(counters)
            self._send(200, resp)
        else:
            self._send(404, {"ok": False, "error": "not_found"})

    def do_POST(self):
        global _INFLIGHT, _REJECTED_429, _SERVED, _SKIPPED_GONE
        if self.path != "/embed":
            self._send(404, {"ok": False, "error": "not_found"})
            return
        # --- Body bound: validate Content-Length BEFORE reading anything ------
        # Strict ASCII-decimal (^[0-9]+$ post-strip) only. str.isdigit() also
        # accepts unicode digits like '²' (raw byte 0xb2, reachable over the
        # wire because http.server decodes headers as latin-1) that int() then
        # rejects with an unhandled ValueError — a dropped connection with no
        # status and a traceback per probe. Digit-set alone is NOT enough for
        # int() to be safe: CPython caps str->int at 4300 digits
        # (sys.set_int_max_str_digits), so the digit-COUNT cap below (15
        # digits ~ 999TB, far above any real Content-Length) must also hold
        # before int() cannot raise.
        cl_s = (self.headers.get("Content-Length") or "").strip()
        if not cl_s or not all("0" <= c <= "9" for c in cl_s):
            self._send(400, {"ok": False, "error": "bad_content_length"})
            return
        if len(cl_s) > 15:
            # Over-long all-digit value: obviously above MAX_BODY_BYTES, and
            # int() on 4300+ digits would raise. 413 without calling int().
            self._send(413, {"ok": False, "error": "body_too_large",
                             "max_bytes": MAX_BODY_BYTES})
            return
        n = int(cl_s)
        if n > MAX_BODY_BYTES:
            # 413 without reading a single body byte — never buffer an
            # attacker-sized payload.
            self._send(413, {"ok": False, "error": "body_too_large",
                             "max_bytes": MAX_BODY_BYTES})
            return
        try:
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception as e:
            self._send(400, {"ok": False, "error": f"bad_json:{e}"})
            return
        texts = req.get("texts")
        if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts):
            self._send(400, {"ok": False, "error": "texts_must_be_string_list"})
            return
        if len(texts) == 0:
            # Same exact 5-key contract as the non-empty path (the exact-key
            # test in test_embed_bounds.py pins both shapes). Safe change:
            # local-embedder-client.js never sends empty texts (embedBatch
            # early-returns [] for length 0) and never reads count/elapsed_ms.
            self._send(200, {"embeddings": [], "model_version": MODEL_VERSION,
                             "dim": 0, "count": 0, "elapsed_ms": 0.0})
            return
        is_query = bool(req.get("is_query", False))
        dim = int(req.get("dim", DEFAULT_DIM) or 0)

        # --- Bounded admission: only validated /embed work counts -------------
        with _CTR_LOCK:
            if _INFLIGHT >= MAX_INFLIGHT:
                _REJECTED_429 += 1
                admitted = False
            else:
                _INFLIGHT += 1
                admitted = True
        if not admitted:
            self._send(429, {"ok": False, "error": "queue_full",
                             "max_inflight": MAX_INFLIGHT})
            return
        try:
            # --- Deadline: server default, tightened by a valid client header -
            budget_ms = REQUEST_DEADLINE_MS
            hdr = self.headers.get("X-Embed-Deadline-Ms")
            if hdr is not None:
                try:
                    h = int(hdr.strip())
                    if h > 0:
                        budget_ms = min(budget_ms, h)
                except ValueError:
                    pass  # invalid header -> server default
            deadline = time.monotonic() + budget_ms / 1000.0

            # --- Acquire the GPU lock in slices so deadline/drain are honored -
            while True:
                if _DRAINING.is_set():
                    self._send(503, {"ok": False, "error": "draining"})
                    return
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self._send(503, {"ok": False, "error": "deadline_exceeded"})
                    return
                if _LOCK.acquire(timeout=min(0.05, remaining)):
                    break

            # --- Holding the lock: re-check BEFORE touching the GPU -----------
            try:
                if _DRAINING.is_set():
                    self._send(503, {"ok": False, "error": "draining"})
                    return
                if time.monotonic() >= deadline:
                    self._send(503, {"ok": False, "error": "deadline_exceeded"})
                    return
                if self._client_gone():
                    # Abandoned work must never reach encode. Skip silently: the
                    # caller is gone, a response would only hit the pipe swallow.
                    # Count it so the skip is observable on /health (additive).
                    with _CTR_LOCK:
                        _SKIPPED_GONE += 1
                    return
                t = time.time()
                vecs = _encode_locked(texts, is_query, dim)
                dt = time.time() - t
            finally:
                _LOCK.release()

            self._send(200, {"embeddings": vecs, "model_version": MODEL_VERSION,
                             "dim": len(vecs[0]) if vecs else 0,
                             "count": len(vecs), "elapsed_ms": round(dt * 1000, 1)})
            with _CTR_LOCK:
                _SERVED += 1
                served = _SERVED
            if RECYCLE_AFTER_REQUESTS > 0 and served >= RECYCLE_AFTER_REQUESTS:
                _begin_drain(f"recycle after {served} requests")
        except Exception as e:
            self._send(500, {"ok": False, "error": f"embed_failed:{e}"})
        finally:
            with _CTR_LOCK:
                _INFLIGHT -= 1


def main():
    global _SRV
    _load_model()
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    _SRV = srv

    def _on_signal(signum, frame):
        _begin_drain(f"signal {signum}")

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    try:
        srv.serve_forever(poll_interval=0.1)
    except KeyboardInterrupt:
        _begin_drain("keyboard interrupt")

    # serve_forever returned => drain in progress. Wait for the in-flight
    # encode(s) to finish (queued-not-on-GPU work 503s itself via the draining
    # flag), then exit 0 — launchd KeepAlive absorbs the restart.
    wait_until = time.monotonic() + DRAIN_TIMEOUT_S
    while time.monotonic() < wait_until:
        with _CTR_LOCK:
            inflight = _INFLIGHT
        if inflight == 0:
            break
        time.sleep(0.05)
    print("embed_server: drained, exit 0", flush=True)
    sys.exit(0)


if __name__ == "__main__":
    main()
