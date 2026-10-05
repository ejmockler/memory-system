#!/usr/bin/env python3
"""test_embed_bounds.py — falsifiable bounds tests for embed_server.py.

Default (fake) mode — run with system python3, no GPU, no real data:

    cd <repo root> && python3 local-embedder/test_embed_bounds.py

Spawns the server as a subprocess (EMBED_TEST_PYTHON if set, else
.venv/bin/python3 if present, else this interpreter; EMBED_FAKE_MODEL=1,
ephemeral EMBED_PORT) and exercises the REAL handler/lock/queue/drain code
paths — only the model object is a stub. Tests:

  a. body bound      — Content-Length > EMBED_MAX_BODY_BYTES -> 413 without the
                       server reading the body; missing Content-Length -> 400.
  b. queue overflow  — EMBED_MAX_INFLIGHT=2 + slow encodes: 8 concurrent POSTs
                       yield >=1 429 and >=1 200 with EXACTLY the contract keys
                       {embeddings, model_version, dim, count, elapsed_ms} and
                       unit-norm vectors.
  c. health          — GET /health answers <500ms with ok:true while the GPU
                       lock is held, and keeps the 5 pre-existing keys.
  d. deadline skip   — an X-Embed-Deadline-Ms:50 request queued behind a 2000ms
                       encode gets 503 deadline_exceeded and the additive
                       gpu_calls counter on /health proves it never hit encode.
  e. SIGTERM drain   — in-flight request completes 200, process exits 0 within
                       EMBED_DRAIN_TIMEOUT_S+5s, post-SIGTERM connections are
                       refused or get 503.
  f. RSS soak        — ~300 sequential+concurrent fake requests; subprocess RSS
                       growth after warmup must stay under a measured threshold
                       (see the comment at the assertion).
  g. client-gone     — an admitted request whose client hangs up before the GPU
                       lock frees is skipped (never reaches encode) and counted
                       in the additive /health key skipped_client_gone.
  i. degenerate row   — (E1) a NaN row inside a >= 2-row fake encode is re-
                       encoded alone and returned unit-norm; /health counts
                       degenerate_rows / degenerate_recovered /
                       degenerate_unrecovered; an always-NaN row leaves as
                       finite all-zeros with siblings intact.

All request bodies are synthetic strings generated below — the tests never read
the real ledger or any operator data.

Real mode — one-time measured soak on the actual model (GPU, ~10min/arm):

    launchctl bootout gui/$(id -u)/com.user.memory-system.embed-server
    EMBED_BOUNDS_REAL=1 python3 local-embedder/test_embed_bounds.py
    launchctl bootstrap gui/$(id -u) \
        ~/Library/LaunchAgents/com.user.memory-system.embed-server.plist

  Runs continuous realistic batches (32 texts x 500-2000 chars) against a fresh
  real-model server on an ephemeral port for EMBED_SOAK_SECONDS (default 600)
  per arm, sampling phys_footprint every 30s:
    arm A: EMBED_MPS_EMPTY_CACHE_EVERY=0 (mitigation off)
    arm B: EMBED_MPS_EMPTY_CACHE_EVERY=1 (production default)
  and asserts arm B's slope stays under EMBED_REAL_MAX_SLOPE_GBH
  (default REAL_ARM_B_MAX_SLOPE_GBH below, set from the measured numbers).

SOAK NUMBERS (measured 2026-07-13, Qwen3-Embedding-8B fp16 on Apple-silicon (MPS);
batches of 32 texts x 500-2000 chars back-to-back at ~60s/batch;
phys_footprint sampled every 30s; 900s time-cap per arm; SOAK END rc=0 —
see 'Real mode' above for the exact command):

  arm 0 (EMBED_MPS_EMPTY_CACHE_EVERY=0, mitigation OFF):
      slope = +20.618 GB/h over 15.1min (32.00GB -> 37.00GB)
  arm 1 (EMBED_MPS_EMPTY_CACHE_EVERY=1, mitigation ON, production default):
      slope = +3.007 GB/h over 15.0min (32.00GB -> 32.00GB; samples oscillated
      26-32GB with no monotonic climb — the endpoint footprints are equal)

  decision: EMBED_MPS_EMPTY_CACHE_EVERY default stays 1. Arm 0 is materially
  worse — +20.618 vs +3.007 GB/h, ~7x the growth rate — confirming that
  per-encode torch.mps.empty_cache() is the correct standing mitigation for
  the MPS allocator's retention (the historical ~1.8GB/h leak at
  daemons/embed-watchdog.sh:2-8 was measured with no empty_cache at all).
  EMBED_RECYCLE_AFTER_REQUESTS stays 0 (disabled): arm 1's endpoints are flat
  (32.00GB -> 32.00GB), so empty_cache is sufficient at this workload and
  self-recycle is not warranted by the data.
  Post-soak the restore trap brought production :8359 back to ok:true
  ('RESTORED HEALTHY' in the soak log), promoting the wave-1+L4b code that
  exposes skipped_client_gone on /health.
"""

import http.client
import json
import math
import os
import signal
import socket
import subprocess
import sys
import threading
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
# Interpreter for the server subprocess: EMBED_TEST_PYTHON if set, else the
# local venv if one exists, else the interpreter running this file (fake mode
# needs only numpy, so a clone with no venv can still run the suite).
_LOCAL_VENV_PY = os.path.join(ROOT, ".venv", "bin", "python3")
VENV_PY = (os.environ.get("EMBED_TEST_PYTHON")
           or (_LOCAL_VENV_PY if os.path.exists(_LOCAL_VENV_PY) else sys.executable))
SERVER_PY = os.path.join(ROOT, "embed_server.py")

# Fake-mode RSS soak: max allowed RSS growth (KB) after warmup. Measured noise
# is documented at the assertion in test_f_rss_soak.
RSS_SOAK_MAX_GROWTH_KB = 1024

# Real-mode arm-B slope gate (GB/h). Finalized 2026-07-13 from the measured
# arm-1 slope of +3.007 GB/h (see SOAK NUMBERS in the module docstring):
# ~3x measured, so the gate tolerates sampling noise but fails on any
# regression toward the arm-0 rate (+20.618 GB/h). Floor of 0.1 not binding.
# Overridable for measurement runs via EMBED_REAL_MAX_SLOPE_GBH.
REAL_ARM_B_MAX_SLOPE_GBH = 9.0

_FAILURES = []


def check(cond, msg):
    if cond:
        print(f"ok - {msg}")
    else:
        print(f"FAIL - {msg}")
        _FAILURES.append(msg)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def raw_request(port, payload, timeout=5):
    """Send raw bytes, return the full response text (read to EOF)."""
    sock = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    try:
        sock.sendall(payload)
        sock.settimeout(timeout)
        chunks = []
        while True:
            try:
                b = sock.recv(4096)
            except socket.timeout:
                break
            if not b:
                break
            chunks.append(b)
        return b"".join(chunks).decode("utf-8", "replace")
    finally:
        sock.close()


def synthetic_texts(count, min_len=500, max_len=2000, seed=0):
    """Deterministic synthetic corpus — NEVER operator data."""
    out = []
    span = max_len - min_len
    for i in range(count):
        n = min_len + ((seed * 7919 + i * 104729) % (span + 1))
        word = f"synthetic-{seed}-{i} "
        out.append((word * (n // len(word) + 1))[:n])
    return out


class ServerProc:
    """Spawn embed_server.py as a subprocess on an ephemeral port."""

    def __init__(self, env_extra=None, fake=True, load_timeout=15):
        self.port = free_port()
        env = dict(os.environ)
        env["EMBED_PORT"] = str(self.port)
        env["EMBED_HOST"] = "127.0.0.1"
        if fake:
            env["EMBED_FAKE_MODEL"] = "1"
        else:
            env.pop("EMBED_FAKE_MODEL", None)
        env.update(env_extra or {})
        self.proc = subprocess.Popen(
            [VENV_PY, SERVER_PY], env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        self.load_timeout = load_timeout

    def wait_health(self):
        deadline = time.time() + self.load_timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"server died at startup rc={self.proc.returncode}")
            try:
                body = self.get("/health", timeout=2)[1]
                if body.get("ok") is True:
                    return body
            except OSError:
                pass
            time.sleep(0.1)
        raise RuntimeError("server never became healthy")

    def get(self, path, timeout=5):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        try:
            conn.request("GET", path)
            r = conn.getresponse()
            return r.status, json.loads(r.read().decode("utf-8"))
        finally:
            conn.close()

    def post(self, obj, headers=None, timeout=30):
        body = json.dumps(obj).encode("utf-8")
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        try:
            hdrs = {"Content-Type": "application/json"}
            hdrs.update(headers or {})
            conn.request("POST", "/embed", body=body, headers=hdrs)
            r = conn.getresponse()
            return r.status, json.loads(r.read().decode("utf-8"))
        finally:
            conn.close()

    def rss_kb(self):
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(self.proc.pid)],
                             capture_output=True, text=True)
        return int(out.stdout.strip() or 0)

    def footprint_gb(self):
        """phys_footprint in GB (captures MPS/IOAccelerator pages that RSS can
        miss); falls back to RSS if the footprint tool is unavailable."""
        try:
            out = subprocess.run(["/usr/bin/footprint", "-p", str(self.proc.pid)],
                                 capture_output=True, text=True, timeout=20)
            for line in out.stdout.splitlines():
                parts = line.split()
                if parts[:1] == ["phys_footprint:"] and len(parts) >= 3:
                    v, unit = float(parts[1]), parts[2]
                    return {"GB": v, "MB": v / 1024, "KB": v / 1048576}.get(unit)
        except Exception:
            pass
        return self.rss_kb() / 1048576.0

    def stop(self, timeout=10):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        return self.proc.returncode


# ---------------------------------------------------------------------------
# a. Request-body bound
# ---------------------------------------------------------------------------

def test_a_body_bound():
    srv = ServerProc({"EMBED_MAX_BODY_BYTES": "4096"})
    try:
        srv.wait_health()

        # Oversized Content-Length, NO body sent: the server must answer 413
        # from the header alone. A regressed server that tries to read the
        # declared 10MB blocks on the empty socket and this read times out.
        resp = raw_request(srv.port,
                           b"POST /embed HTTP/1.1\r\nHost: t\r\n"
                           b"Content-Type: application/json\r\n"
                           b"Content-Length: 10485760\r\n\r\n")
        check(" 413 " in resp.splitlines()[0],
              f"oversized Content-Length -> 413 (got: {resp.splitlines()[0]!r})")
        check("body_too_large" in resp, "413 body carries error=body_too_large")

        # Missing Content-Length -> 400 bad_content_length.
        resp = raw_request(srv.port, b"POST /embed HTTP/1.1\r\nHost: t\r\n\r\n")
        check(" 400 " in resp.splitlines()[0], "missing Content-Length -> 400")
        check("bad_content_length" in resp, "400 body carries error=bad_content_length")

        # Unicode-digit Content-Length -> 400, never a dropped connection.
        # http.server decodes headers as latin-1, so raw byte 0xb2 arrives as
        # '²' (SUPERSCRIPT TWO): str.isdigit() is True but int() raises
        # ValueError. A regressed server crashes the handler thread and drops
        # the connection with NO status line; the fixed strict-ASCII parse
        # answers 400 bad_content_length.
        for raw_byte, name in ((b"\xb2", "0xb2 superscript-two"),
                               (b"\xb3", "0xb3 superscript-three")):
            resp = raw_request(srv.port,
                               b"POST /embed HTTP/1.1\r\nHost: t\r\n"
                               b"Content-Type: application/json\r\n"
                               b"Content-Length: " + raw_byte + b"\r\n\r\n")
            first = (resp.splitlines()[0] if resp.strip()
                     else "<connection dropped, no status>")
            check(" 400 " in first,
                  f"unicode-digit Content-Length ({name}) -> 400 (got: {first!r})")
            check("bad_content_length" in resp,
                  f"unicode-digit Content-Length ({name}) body carries bad_content_length")

        # Over-long all-ASCII-digit Content-Length -> 400/413, never a dropped
        # connection. CPython caps str->int conversion at 4300 digits
        # (sys.set_int_max_str_digits default), so a 4400-digit value passes
        # the strict ^[0-9]+$ parse but makes a bare int() raise ValueError —
        # a regressed server crashes the handler thread and drops the
        # connection with NO status line. The fixed server rejects on digit
        # COUNT (>15 digits) before ever calling int().
        resp = raw_request(srv.port,
                           b"POST /embed HTTP/1.1\r\nHost: t\r\n"
                           b"Content-Type: application/json\r\n"
                           b"Content-Length: " + b"9" * 4400 + b"\r\n\r\n")
        first = (resp.splitlines()[0] if resp.strip()
                 else "<connection dropped, no status>")
        check(" 400 " in first or " 413 " in first,
              f"4400-digit Content-Length -> 400/413 (got: {first!r})")

        # In-bounds request still works on the same server.
        status, body = srv.post({"texts": ["hello"]})
        check(status == 200, f"in-bounds request still 200 (got {status})")

        # Empty-texts fast path answers 200 with EXACTLY the same 5 contract
        # keys as the non-empty path (count:0, elapsed_ms:0.0) — no divergent
        # 3-key shape. (The 3-key shape was pre-existing wave-1 behavior;
        # local-embedder-client.js never sends empty texts, so unifying is a
        # safe contract cleanup, and this assertion pins it.)
        status, body = srv.post({"texts": []})
        check(status == 200, f"empty-texts request -> 200 (got {status})")
        check(set(body.keys()) == {"embeddings", "model_version", "dim",
                                   "count", "elapsed_ms"},
              f"empty-texts 200 has exactly the contract keys (got {sorted(body.keys())})")
        check(body["embeddings"] == [] and body["count"] == 0
              and body["elapsed_ms"] == 0.0 and body["dim"] == 0,
              "empty-texts 200 carries embeddings:[], count:0, elapsed_ms:0.0, dim:0")
    finally:
        srv.stop()


# ---------------------------------------------------------------------------
# b + c. Queue overflow (429 + exact 200 contract) and health under load
# ---------------------------------------------------------------------------

def test_bc_overflow_and_health():
    srv = ServerProc({"EMBED_FAKE_LATENCY_MS": "2000", "EMBED_MAX_INFLIGHT": "2"})
    try:
        srv.wait_health()
        results = []
        lock = threading.Lock()

        def fire(i):
            try:
                status, body = srv.post({"texts": [f"load-{i}"]}, timeout=30)
            except Exception as e:
                status, body = -1, {"error": str(e)}
            with lock:
                results.append((status, body))

        threads = [threading.Thread(target=fire, args=(i,)) for i in range(8)]
        for t in threads:
            t.start()

        # c. Health under load: the first admitted request holds the GPU lock
        # for 2000ms; /health must answer well inside 500ms with ok:true and
        # the five pre-existing keys. (A /health that blocks on the GPU lock
        # fails this by timeout.)
        time.sleep(0.3)  # let the slow encodes take the lock
        t0 = time.monotonic()
        hstatus, health = srv.get("/health", timeout=0.5)
        health_ms = (time.monotonic() - t0) * 1000
        check(hstatus == 200 and health.get("ok") is True,
              f"/health ok:true under GPU load (status={hstatus})")
        check(health_ms < 500, f"/health answered in {health_ms:.0f}ms (<500ms) under load")
        for k in ("ok", "model", "model_version", "device", "native_dim"):
            check(k in health, f"/health keeps pre-existing key '{k}'")

        for t in threads:
            t.join(timeout=30)
        statuses = sorted(s for s, _ in results)
        check(statuses.count(429) >= 1, f"at least one 429 under overflow (statuses={statuses})")
        check(statuses.count(200) >= 1, f"at least one 200 under overflow (statuses={statuses})")

        for status, body in results:
            if status == 429:
                check(body.get("ok") is False and body.get("error") == "queue_full"
                      and body.get("max_inflight") == 2,
                      "429 body is {ok:false,error:queue_full,max_inflight:2}")
                break
        for status, body in results:
            if status == 200:
                # EXACT contract keys — an extra or missing key breaks
                # byte-compatibility with local-embedder-client.js.
                check(set(body.keys()) == {"embeddings", "model_version", "dim",
                                           "count", "elapsed_ms"},
                      f"200 body has exactly the contract keys (got {sorted(body.keys())})")
                vec = body["embeddings"][0]
                norm = sum(x * x for x in vec) ** 0.5
                check(abs(norm - 1.0) < 1e-3, f"200 vector is unit-norm (|v|={norm:.6f})")
                check(body["count"] == 1 and body["dim"] == len(vec),
                      "200 count/dim match the payload")
                break
    finally:
        srv.stop()


# ---------------------------------------------------------------------------
# d. Deadline skip — abandoned work never reaches encode (gpu_calls proof)
# ---------------------------------------------------------------------------

def test_d_deadline_skip():
    srv = ServerProc({"EMBED_FAKE_LATENCY_MS": "2000", "EMBED_MAX_INFLIGHT": "8"})
    try:
        srv.wait_health()
        slow_result = {}

        def slow():
            slow_result["r"] = srv.post({"texts": ["slow-one"]}, timeout=30)

        th = threading.Thread(target=slow)
        th.start()

        # Wait until the slow request is ON the GPU (gpu_calls goes to 1).
        deadline = time.time() + 5
        while time.time() < deadline:
            if srv.get("/health")[1].get("gpu_calls", 0) >= 1:
                break
            time.sleep(0.02)
        gpu_before = srv.get("/health")[1]["gpu_calls"]
        check(gpu_before == 1, f"slow request reached encode (gpu_calls={gpu_before})")

        # Queue a 50ms-deadline request behind the 2000ms one: it must give up
        # while waiting for the lock and answer 503 deadline_exceeded fast.
        t0 = time.monotonic()
        status, body = srv.post({"texts": ["doomed"]},
                                headers={"X-Embed-Deadline-Ms": "50"}, timeout=10)
        waited_ms = (time.monotonic() - t0) * 1000
        check(status == 503 and body.get("error") == "deadline_exceeded",
              f"50ms-deadline request behind slow encode -> 503 deadline_exceeded "
              f"(got {status} {body.get('error')})")
        check(waited_ms < 1500, f"deadline 503 returned in {waited_ms:.0f}ms, "
              "before the in-flight encode finished")

        th.join(timeout=30)
        check(slow_result["r"][0] == 200, "slow request itself still completed 200")
        after = srv.get("/health")[1]
        # THE invariant: the doomed request never incremented gpu_calls.
        check(after["gpu_calls"] == gpu_before,
              f"gpu_calls did not increment for the deadline-expired request "
              f"({gpu_before} -> {after['gpu_calls']})")
        check(after["served"] == 1 and after["inflight"] == 0,
              f"counters settle (served={after['served']}, inflight={after['inflight']})")
    finally:
        srv.stop()


# ---------------------------------------------------------------------------
# e. Graceful SIGTERM drain
# ---------------------------------------------------------------------------

def test_e_sigterm_drain():
    drain_timeout_s = 20
    srv = ServerProc({"EMBED_FAKE_LATENCY_MS": "2000",
                      "EMBED_DRAIN_TIMEOUT_S": str(drain_timeout_s)})
    try:
        srv.wait_health()
        inflight_result = {}
        queued_result = {}

        def inflight():
            inflight_result["r"] = srv.post({"texts": ["inflight"]}, timeout=30)

        def queued():
            try:
                queued_result["r"] = srv.post({"texts": ["queued"]}, timeout=30)
            except Exception as e:
                queued_result["r"] = (-1, {"error": str(e)})

        t1 = threading.Thread(target=inflight)
        t1.start()
        # Ensure the in-flight request is actually holding the GPU lock.
        deadline = time.time() + 5
        while time.time() < deadline:
            if srv.get("/health")[1].get("gpu_calls", 0) >= 1:
                break
            time.sleep(0.02)
        t2 = threading.Thread(target=queued)
        t2.start()
        time.sleep(0.2)  # let the queued one start waiting on the lock

        srv.proc.send_signal(signal.SIGTERM)

        t1.join(timeout=30)
        t2.join(timeout=30)
        check(inflight_result["r"][0] == 200,
              f"in-flight request completed 200 across SIGTERM (got {inflight_result['r'][0]})")
        qs = queued_result["r"][0]
        check(qs == 503, f"queued-not-on-GPU request got 503 during drain (got {qs})")

        try:
            rc = srv.proc.wait(timeout=drain_timeout_s + 5)
        except subprocess.TimeoutExpired:
            rc = None
        check(rc == 0, f"server exited 0 within drain timeout (rc={rc})")

        # Post-SIGTERM new work: connection refused (listener closed) or 503.
        try:
            status, _ = srv.post({"texts": ["late"]}, timeout=3)
            check(status == 503, f"post-SIGTERM request got 503 (got {status})")
        except OSError:
            check(True, "post-SIGTERM connection refused")
    finally:
        srv.stop()


# ---------------------------------------------------------------------------
# f. Fake-mode RSS soak — the HTTP/queue layer must not retain bodies/threads
# ---------------------------------------------------------------------------

def test_f_rss_soak():
    srv = ServerProc({"EMBED_FAKE_LATENCY_MS": "0", "EMBED_MAX_INFLIGHT": "8"})
    try:
        srv.wait_health()
        texts = synthetic_texts(32, 500, 2000, seed=1)

        def burst(k):
            ths = []
            for i in range(k):
                th = threading.Thread(
                    target=lambda: srv.post({"texts": texts}, timeout=30))
                th.start()
                ths.append(th)
            for th in ths:
                th.join(timeout=30)

        # Warmup: let allocator pools / thread stacks reach steady state.
        for _ in range(50):
            srv.post({"texts": texts}, timeout=30)
        burst(6)
        base_kb = srv.rss_kb()

        # ~300 requests: 240 sequential + 10 concurrent bursts of 6.
        for _ in range(240):
            srv.post({"texts": texts}, timeout=30)
        for _ in range(10):
            burst(6)

        end_kb = srv.rss_kb()
        growth_kb = end_kb - base_kb
        # THRESHOLD (measured 2026-07-12 on this machine): across 6 observation
        # runs of this exact loop, post-warmup RSS growth was 80/128/128/160/
        # 176/304 KB (python allocator-arena noise). Threshold = 1024KB, ~3x
        # the observed 304KB noise ceiling. A regression that retains request
        # bodies (~40KB each x 300 requests ~= +12MB) or leaks handler threads
        # (stack + arena per request) lands far above this gate, so the
        # assertion CAN fail against a regressed server while staying stable
        # against noise.
        check(growth_kb < RSS_SOAK_MAX_GROWTH_KB,
              f"fake-mode RSS growth {growth_kb}KB over ~300 requests "
              f"(< {RSS_SOAK_MAX_GROWTH_KB}KB; base={base_kb}KB end={end_kb}KB)")
        h = srv.get("/health")[1]
        check(h["inflight"] == 0, f"inflight settled to 0 after soak (got {h['inflight']})")
        check(h["served"] >= 300, f"soak actually served >=300 requests (got {h['served']})")
    finally:
        srv.stop()


# ---------------------------------------------------------------------------
# g. Client-gone skip — an abandoned admitted request never reaches encode
# ---------------------------------------------------------------------------

def test_g_client_gone_skip():
    srv = ServerProc({"EMBED_FAKE_LATENCY_MS": "1500", "EMBED_MAX_INFLIGHT": "8"})
    try:
        srv.wait_health()
        slow_result = {}

        def slow():
            slow_result["r"] = srv.post({"texts": ["slow-hold"]}, timeout=30)

        th = threading.Thread(target=slow)
        th.start()
        # Wait until the slow request is ON the GPU (holding _LOCK).
        deadline = time.time() + 5
        while time.time() < deadline:
            if srv.get("/health")[1].get("gpu_calls", 0) >= 1:
                break
            time.sleep(0.02)
        check(srv.get("/health")[1]["gpu_calls"] == 1,
              "slow request reached encode (gpu_calls=1)")

        # Abandoned request: one COMPLETE valid POST over a raw socket, then
        # close the socket BEFORE any response. By then the handler has read
        # the full body and been admitted, so the only pending-readable event
        # on its connection is our EOF -> _client_gone() fires when it finally
        # acquires the lock behind the 1500ms encode.
        body = json.dumps({"texts": ["abandoned-request"]}).encode("utf-8")
        payload = (b"POST /embed HTTP/1.1\r\nHost: t\r\n"
                   b"Content-Type: application/json\r\n"
                   b"Content-Length: " + str(len(body)).encode("ascii")
                   + b"\r\n\r\n" + body)
        sock = socket.create_connection(("127.0.0.1", srv.port), timeout=5)
        try:
            sock.sendall(payload)
            time.sleep(0.3)  # let the handler read the body and get admitted
        finally:
            sock.close()     # client gone, no response ever read

        th.join(timeout=30)
        check(slow_result["r"][0] == 200,
              "slow request completed 200 (the GPU lock cycled)")

        # The abandoned handler observes the closed peer once it gets the
        # lock; poll until the counters settle.
        deadline = time.time() + 5
        h = {}
        while time.time() < deadline:
            h = srv.get("/health")[1]
            if h.get("skipped_client_gone", 0) >= 1 and h.get("inflight", 1) == 0:
                break
            time.sleep(0.05)
        check(h.get("skipped_client_gone") == 1,
              f"/health skipped_client_gone == 1 (got {h.get('skipped_client_gone')})")
        check(h.get("gpu_calls") == 1,
              f"abandoned request never reached encode (gpu_calls={h.get('gpu_calls')})")
        check(h.get("served") == 1,
              f"only the slow request was served (served={h.get('served')})")
        check(h.get("inflight") == 0,
              f"inflight settled to 0 (got {h.get('inflight')})")
    finally:
        srv.stop()


# ---------------------------------------------------------------------------
# Real-model soak (EMBED_BOUNDS_REAL=1) — measures the MPS leak per arm
# ---------------------------------------------------------------------------

def _real_soak_arm(empty_cache_every, soak_seconds, max_batches=0):
    print(f"--- real soak arm EMBED_MPS_EMPTY_CACHE_EVERY={empty_cache_every} "
          f"({soak_seconds}s, max_batches={max_batches or 'unlimited'}) ---",
          flush=True)
    srv = ServerProc({"EMBED_MPS_EMPTY_CACHE_EVERY": str(empty_cache_every),
                      "EMBED_REQUEST_DEADLINE_MS": "300000"},
                     fake=False, load_timeout=300)
    samples = []  # (elapsed_s, footprint_gb)
    try:
        srv.wait_health()
        texts = synthetic_texts(32, 500, 2000, seed=2)
        # Warm up the GPU + allocator before the baseline sample.
        for _ in range(3):
            srv.post({"texts": texts}, timeout=300)
        t0 = time.monotonic()
        next_sample = 0.0
        batches = 0
        while time.monotonic() - t0 < soak_seconds:
            if max_batches and batches >= max_batches:
                break  # EMBED_SOAK_BATCHES bound (0 = unlimited, time-only)
            el = time.monotonic() - t0
            if el >= next_sample:
                gb = srv.footprint_gb()
                samples.append((el, gb))
                print(f"  t={el:6.0f}s footprint={gb:.2f}GB batches={batches}", flush=True)
                next_sample += 30.0
            srv.post({"texts": texts}, timeout=300)
            batches += 1
        samples.append((time.monotonic() - t0, srv.footprint_gb()))
        print(f"  done: {batches} batches", flush=True)
    finally:
        rc = srv.stop(timeout=30)
        print(f"  arm server exit rc={rc}", flush=True)
    # Least-squares slope in GB/h.
    xs = [s / 3600.0 for s, _ in samples]
    ys = [g for _, g in samples]
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    denom = sum((x - mx) ** 2 for x in xs) or 1e-12
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / denom
    dur_min = samples[-1][0] / 60.0
    print(f"  arm {empty_cache_every}: slope={slope:+.3f} GB/h over {dur_min:.1f}min "
          f"({ys[0]:.2f}GB -> {ys[-1]:.2f}GB)", flush=True)
    return slope, dur_min, ys[0], ys[-1]


def real_soak():
    soak_seconds = int(os.environ.get("EMBED_SOAK_SECONDS", "600"))
    max_batches = int(os.environ.get("EMBED_SOAK_BATCHES", "0"))  # 0 = unlimited
    arms = os.environ.get("EMBED_SOAK_ARMS", "0,1").split(",")
    results = {}
    for arm in arms:
        results[arm] = _real_soak_arm(int(arm), soak_seconds, max_batches)
    if "1" in results:
        max_slope = float(os.environ.get("EMBED_REAL_MAX_SLOPE_GBH",
                                         str(REAL_ARM_B_MAX_SLOPE_GBH)))
        slope_b = results["1"][0]
        check(slope_b < max_slope,
              f"arm B (empty_cache every 1) slope {slope_b:+.3f} GB/h < {max_slope} GB/h")
    print("REAL SOAK RESULTS:", flush=True)
    for arm, (slope, dur, g0, g1) in results.items():
        print(f"  EMBED_MPS_EMPTY_CACHE_EVERY={arm}: {slope:+.3f} GB/h "
              f"over {dur:.1f}min ({g0:.2f}GB -> {g1:.2f}GB)", flush=True)


def test_h_batch_token_budget():
    """H — batch_size adapts to text length so ONE forward pass has a bounded
    padded-token area.

    Regression: batch_size was hardcoded min(len(texts), 64). Since
    sentence-transformers pads every text in a batch to that batch's longest
    member, a full 64-wide batch of 2048-token texts is ~131k padded tokens in
    a single pass, which on MPS produced transient spikes measured at 47, 67,
    71 and 77 GB (and 116/149 GB before the watchdog killed the process). It is
    a spike INSIDE one encode, not a slow leak, which is why a per-request-count
    recycle valve could not help: the process passed 45 GB at request 44 of 128.

    This is not a cap on what can be embedded — every text is still embedded at
    full length. Only the WIDTH of a pass adapts, so the corpus p50 (~13 tokens)
    keeps the full 64 and loses no throughput.
    """
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "embed_server_under_test", SERVER_PY
    )
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)

    budget = m.MAX_BATCH_TOKENS

    def padded_area(chars, n=64):
        texts = ["x" * chars] * n
        bs = m._batch_size_for(texts)
        est = min(m.MAX_SEQ_TOKENS, max(1, chars // 4))
        return bs, bs * est

    bs_short, area_short = padded_area(52)          # ~13 tokens, corpus p50
    bs_long, area_long = padded_area(8192)          # 2048 tokens, the seq cap

    check(bs_short == m.MAX_BATCH_SIZE,
          f"short texts keep the full batch ceiling (got {bs_short})")
    check(area_short <= budget,
          f"short-text pass is inside the token budget ({area_short} <= {budget})")
    check(bs_long < m.MAX_BATCH_SIZE,
          f"max-length texts narrow the batch (got {bs_long})")
    check(area_long <= budget,
          f"max-length pass is inside the token budget ({area_long} <= {budget})")

    # The property that actually bounds memory: padded area never exceeds the
    # budget at ANY input length, and is far below the old fixed-64 behaviour.
    worst = 0
    for chars in (4, 52, 400, 1024, 4096, 8192, 100000):
        _, area = padded_area(chars)
        worst = max(worst, area)
    check(worst <= budget,
          f"padded-token area bounded across all lengths (worst={worst:,} <= {budget:,})")
    old_worst = m.MAX_BATCH_SIZE * m.MAX_SEQ_TOKENS
    check(worst < old_worst,
          f"bounded below the old fixed-batch worst case ({worst:,} < {old_worst:,})")

    # Degenerate inputs must never produce a zero/negative batch size.
    check(m._batch_size_for([]) >= 1, "empty input yields a valid batch size")
    check(m._batch_size_for([""]) >= 1, "empty string yields a valid batch size")
    check(m._batch_size_for(["x" * 10_000_000]) >= 1,
          "pathologically long single text still yields batch >= 1")


def test_i_degenerate_row_recovery():
    """E1 zero-norm-embedding-root-cause. The fake model's EMBED_FAKE_NAN_MARKER
    seam reproduces the measured fault class exactly: a marked text comes back
    NaN ONLY inside a >= 2-row encode (0/620 production events had items=1).
    The server must re-encode that row alone, hand back three unit-norm rows,
    and count the event on /health; the same text alone is clean and does not
    move the counters; with EMBED_FAKE_NAN_ALWAYS=1 the re-encode fails too and
    the row leaves as finite all-zeros (wire contract unchanged), counted as
    unrecovered. Wave-2 additions: the EMBED_FAKE_GARBAGE_MARKER seam (a FINITE
    |x|=300 row, caught by the |norm-1| > DEGENERATE_NORM_TOL mask rather than
    silently renormalized), the whole-batch skip (all rows bad -> no re-encode,
    gpu_calls +1) and the EMBED_DEGENERATE_RETRY_MAX cap (recovered == cap,
    gpu_calls == 1 + cap)."""
    marker = "\x00NAN"  # the server's EMBED_FAKE_NAN_MARKER default
    good_a = "degenerate-recovery-good-row-a"
    good_b = "degenerate-recovery-good-row-b"
    marked = "degenerate-recovery-" + marker + "-row"
    garbage = "degenerate-recovery-\x00GARBAGE-row"  # EMBED_FAKE_GARBAGE_MARKER default
    contract_keys = {"embeddings", "model_version", "dim", "count", "elapsed_ms"}

    def norms(vecs):
        return [math.sqrt(sum(x * x for x in v)) for v in vecs]

    def finite(vecs):
        return all(math.isfinite(x) for v in vecs for x in v)

    def degenerate_triple(h):
        return (h.get("degenerate_rows"), h.get("degenerate_recovered"),
                h.get("degenerate_unrecovered"))

    print("--- degenerate-row recovery (E1) ---", flush=True)
    srv = ServerProc()
    try:
        srv.wait_health()
        # (a) a marked row in the middle of a 3-row batch is recovered alone.
        status, body = srv.post({"texts": [good_a, marked, good_b],
                                 "is_query": False, "dim": 8})
        check(status == 200, f"[good, marker, good] -> 200 (got {status})")
        check(set(body.keys()) == contract_keys,
              f"/embed response keys unchanged after recovery ({sorted(body.keys())})")
        vecs = body.get("embeddings") or []
        ns = norms(vecs)
        check(len(vecs) == 3, f"three rows returned (got {len(vecs)})")
        check(finite(vecs), "every element finite after recovery")
        check(all(abs(n - 1.0) < 1e-4 for n in ns),
              f"all three rows unit-norm after the single-row re-encode (norms={ns})")
        h = srv.get("/health")[1]
        check(degenerate_triple(h) == (1, 1, 0),
              f"/health degenerate_rows=1 recovered=1 unrecovered=0 (got {degenerate_triple(h)})")

        # (b) the same marked text ALONE embeds cleanly: the fault is batch-only.
        status, body = srv.post({"texts": [marked], "is_query": False, "dim": 8})
        vecs = body.get("embeddings") or []
        ns = norms(vecs)
        check(status == 200 and len(vecs) == 1 and abs(ns[0] - 1.0) < 1e-4,
              f"marker text alone is a unit-norm row (norms={ns})")
        h = srv.get("/health")[1]
        check(degenerate_triple(h) == (1, 1, 0),
              f"single-row request leaves the degenerate counters unchanged (got {degenerate_triple(h)})")

        # (a2) the FINITE-garbage shape of the same fault (|x| = 300 inside a
        # >= 2-row encode): the tolerance mask |norm-1| > DEGENERATE_NORM_TOL
        # must catch it — at HEAD the un-cast fp16 norm overflowed it to zero
        # (loud); a bare float32 cast would silently renormalize it into a
        # plausible unit vector. Expect three unit rows and /health delta
        # (+1, +1, +0), i.e. (2, 2, 0) cumulatively.
        status, body = srv.post({"texts": [good_a, garbage, good_b],
                                 "is_query": False, "dim": 8})
        check(status == 200, f"[good, garbage, good] -> 200 (got {status})")
        vecs = body.get("embeddings") or []
        ns = norms(vecs)
        check(len(vecs) == 3 and finite(vecs) and all(abs(n - 1.0) < 1e-4 for n in ns),
              f"finite-garbage row recovered: three unit-norm rows (norms={ns})")
        h = srv.get("/health")[1]
        check(degenerate_triple(h) == (2, 2, 0),
              f"/health delta (1,1,0) for the garbage row -> cumulative (2,2,0) (got {degenerate_triple(h)})")
    finally:
        srv.stop()

    # (c) the re-encode ALSO fails -> finite all-zero row, siblings intact.
    srv = ServerProc({"EMBED_FAKE_NAN_ALWAYS": "1"})
    try:
        srv.wait_health()
        status, body = srv.post({"texts": [good_a, marked], "is_query": False, "dim": 8})
        check(status == 200, f"[good, marker] with EMBED_FAKE_NAN_ALWAYS=1 -> 200 (got {status})")
        check(set(body.keys()) == contract_keys,
              "/embed response keys unchanged on the unrecovered path")
        vecs = body.get("embeddings") or []
        check(len(vecs) == 2, f"two rows returned (got {len(vecs)})")
        check(finite(vecs), "unrecovered row is finite (never NaN on the wire)")
        ns = norms(vecs)
        check(abs(ns[0] - 1.0) < 1e-4, f"sibling row stays unit-norm (norm={ns[0]})")
        check(len(vecs) == 2 and all(x == 0.0 for x in vecs[1]),
              "unrecovered row is all-zero")
        h = srv.get("/health")[1]
        check(degenerate_triple(h) == (1, 0, 1),
              f"/health degenerate_rows=1 recovered=0 unrecovered=1 (got {degenerate_triple(h)})")
        for k in ("ok", "model", "model_version", "device", "native_dim",
                  "gpu_calls", "rejected_429", "inflight", "served", "skipped_client_gone"):
            check(k in h, f"/health keeps pre-existing key '{k}' beside the degenerate counters")

        # (c2) persistent finite garbage: the re-encoded row is ALSO |x|=300 and
        # must be rejected by the same tolerance check, leaving exactly one
        # all-zero row (never a renormalized garbage unit vector).
        status, body = srv.post({"texts": [good_a, garbage], "is_query": False, "dim": 8})
        vecs = body.get("embeddings") or []
        ns = norms(vecs)
        check(status == 200 and len(vecs) == 2 and finite(vecs),
              f"[good, garbage] with EMBED_FAKE_NAN_ALWAYS=1 -> 200, two finite rows (got {status})")
        check(len(vecs) == 2 and abs(ns[0] - 1.0) < 1e-4 and all(x == 0.0 for x in vecs[1]),
              f"persistent garbage row leaves all-zero, sibling unit-norm (norms={ns})")
        h = srv.get("/health")[1]
        check(degenerate_triple(h) == (2, 0, 2),
              f"/health unrecovered +1 for persistent garbage -> (2,0,2) (got {degenerate_triple(h)})")
    finally:
        srv.stop()

    # (d) whole-batch fault: every row of an 8-row batch is degenerate. That is
    # a GPU fault, not the one-row class — recovery is skipped outright (no
    # serial re-encodes under _LOCK), all eight rows leave all-zero, counted
    # as 8 unrecovered, and gpu_calls advances by exactly 1 (the primary encode).
    srv = ServerProc()
    try:
        srv.wait_health()
        gpu0 = srv.get("/health")[1].get("gpu_calls")
        texts = [f"degenerate-whole-batch-{i}-" + marker for i in range(8)]
        status, body = srv.post({"texts": texts, "is_query": False, "dim": 8})
        vecs = body.get("embeddings") or []
        check(status == 200 and len(vecs) == 8 and finite(vecs),
              f"8-row all-marked batch -> 200, eight finite rows (got {status}, {len(vecs)})")
        check(len(vecs) == 8 and all(all(x == 0.0 for x in v) for v in vecs),
              "whole-batch fault: all eight rows all-zero")
        h = srv.get("/health")[1]
        check(degenerate_triple(h) == (8, 0, 8),
              f"/health degenerate_rows +8, recovered +0, unrecovered +8 (got {degenerate_triple(h)})")
        check(h.get("gpu_calls") == gpu0 + 1,
              f"whole-batch skip: gpu_calls advanced by exactly 1 (got {h.get('gpu_calls')} from {gpu0})")
    finally:
        srv.stop()

    # (e) retry cap: 9 of 10 rows marked with EMBED_DEGENERATE_RETRY_MAX=2 ->
    # exactly 2 single-row re-encodes (recovered 2), the other 7 leave all-zero
    # unrecovered, and gpu_calls advances by 1 primary + 2 retries = 3.
    srv = ServerProc({"EMBED_DEGENERATE_RETRY_MAX": "2"})
    try:
        srv.wait_health()
        gpu0 = srv.get("/health")[1].get("gpu_calls")
        texts = [good_a] + [f"degenerate-retry-cap-{i}-" + marker for i in range(9)]
        status, body = srv.post({"texts": texts, "is_query": False, "dim": 8})
        vecs = body.get("embeddings") or []
        ns = norms(vecs)
        check(status == 200 and len(vecs) == 10 and finite(vecs),
              f"10-row batch with 9 marked -> 200, ten finite rows (got {status}, {len(vecs)})")
        unit = sum(1 for n in ns if abs(n - 1.0) < 1e-4)
        zero = sum(1 for v in vecs if all(x == 0.0 for x in v))
        check(unit == 3 and zero == 7,
              f"retry cap 2: 1 good + 2 recovered unit rows, 7 all-zero (unit={unit} zero={zero})")
        h = srv.get("/health")[1]
        check(degenerate_triple(h) == (9, 2, 7),
              f"/health degenerate_rows=9 recovered=2 unrecovered=7 (got {degenerate_triple(h)})")
        check(h.get("gpu_calls") == gpu0 + 3,
              f"retry cap: gpu_calls advanced by exactly 3 (got {h.get('gpu_calls')} from {gpu0})")
    finally:
        srv.stop()


def main():
    if not os.path.exists(VENV_PY):
        print(f"FAIL - server python missing at {VENV_PY} "
              f"(set EMBED_TEST_PYTHON or create local-embedder/.venv)")
        sys.exit(1)
    if os.environ.get("EMBED_BOUNDS_REAL") == "1":
        real_soak()
    else:
        test_a_body_bound()
        test_bc_overflow_and_health()
        test_d_deadline_skip()
        test_e_sigterm_drain()
        test_f_rss_soak()
        test_g_client_gone_skip()
        test_h_batch_token_budget()
        test_i_degenerate_row_recovery()
    if _FAILURES:
        print(f"\nFAIL: {len(_FAILURES)} assertion(s) failed")
        sys.exit(1)
    print("\nPASS: all embed bounds tests")
    sys.exit(0)


if __name__ == "__main__":
    main()
