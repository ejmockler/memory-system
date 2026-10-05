#!/usr/bin/env python3
# rerank_server.py — persistent local cross-encoder reranker for memory-system
# recall Layer-3. Mirrors embed_server.py (ThreadingHTTPServer + a single GPU
# _LOCK + /health + a NaN/inf-scrubbed JSON wire) but holds a Qwen3-Reranker
# instead of the embedding model.
#
# WHY: recall.js Layer-3 was a DEAD Gemini-Flash call — with no GEMINI_API_KEY
# every query degraded (degraded_recall_layer3=true) to a final_score sort. This
# server is the LOCAL, unmetered, private replacement: the operator's content
# never leaves the machine, and there is no per-key quota.
#
# Protocol (JSON over HTTP):
#   POST /rerank  {"query": str, "documents": [str, ...], "instruction"?: str}
#                 -> {"scores": [float, ...]}  (one P(relevant) per document,
#                    same order as input; higher = more relevant)
#   GET  /health  -> {"ok": true, "model": "...", "device": "mps|cuda|cpu"}
#
# SCORING: Qwen3-Reranker is a causal LM used as a yes/no relevance judge. We
# format the canonical Qwen3-Reranker chat prompt (system + instruction + query
# + document) ending right before the assistant's yes/no token, then read the
# logits at that final position and take softmax over the "yes"/"no" token ids.
# score = P("yes"). This is the documented Qwen3-Reranker usage; it gives a
# calibrated [0,1] relevance probability, not a raw logit.
#
# OFFLINE NOTE: the Qwen3-Reranker weights must be present in the HF cache. If
# they are not (the model could not be downloaded), this server fails fast at
# startup and recall.js stays on its safe degrade-to-final_score path: a server
# that is down is a network failure to local-reranker-client.js, which rerank.js
# classifies "network" and degrades reorder-only. As of 2026-07-31 the
# LOCAL_RERANKER_ENABLED CAP ships TRUE, so this server IS the default Layer-3
# backend; env LOCAL_RERANKER_ENABLED=0 forces recall back onto the gemini path.

import json, os, time, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

MODEL_ID = os.environ.get("RERANK_MODEL", "Qwen/Qwen3-Reranker-0.6B")
MODEL_VERSION = os.environ.get("RERANK_MODEL_VERSION", "qwen3-reranker-0.6b")
HOST = os.environ.get("RERANK_HOST", "127.0.0.1")
PORT = int(os.environ.get("RERANK_PORT", "8360"))
MAX_LEN = int(os.environ.get("RERANK_MAX_TOKENS", "2048"))
DEFAULT_INSTRUCTION = (
    "Given a memory-recall query, judge whether the candidate memory is "
    "relevant to answering it."
)


# MODEL / DEVICE: RERANK_MODEL (above) picks the model id; RERANK_DEVICE picks
# the torch device (unset = auto-detect: mps, then cuda, then cpu). dtype is
# fp16 on mps/cuda and fp32 on cpu.
def _resolve_device(requested):
    """The RERANK_DEVICE request if set, else the best available backend
    (mps, then cuda, then cpu)."""
    if requested:
        return requested
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


_DEVICE = _resolve_device(os.environ.get("RERANK_DEVICE", "").strip().lower())
# fp16 on a GPU backend (the production tier); fp32 on CPU.
_HALF = _DEVICE.startswith(("mps", "cuda"))
_DTYPE = torch.float16 if _HALF else torch.float32

print(f"rerank_server: loading {MODEL_ID} ({'fp16' if _HALF else 'fp32'}, {_DEVICE}) ...",
      flush=True)
_t0 = time.time()
_TOK = AutoTokenizer.from_pretrained(MODEL_ID, padding_side="left")
_MODEL = AutoModelForCausalLM.from_pretrained(
    MODEL_ID, torch_dtype=_DTYPE
).to(_DEVICE).eval()
# The yes/no token ids the reranker decides between.
_YES_ID = _TOK.convert_tokens_to_ids("yes")
_NO_ID = _TOK.convert_tokens_to_ids("no")
# Qwen3-Reranker canonical prompt scaffold.
_PREFIX = (
    "<|im_start|>system\nJudge whether the Document meets the requirements "
    "based on the Query and the Instruct provided. Note that the answer can "
    'only be "yes" or "no".<|im_end|>\n<|im_start|>user\n'
)
_SUFFIX = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
_LOCK = threading.Lock()
print(f"rerank_server: ready in {time.time()-_t0:.1f}s | yes={_YES_ID} no={_NO_ID} | "
      f"listening http://{HOST}:{PORT}", flush=True)


def _format(query, doc, instruction):
    return (
        f"{_PREFIX}<Instruct>: {instruction}\n<Query>: {query}\n"
        f"<Document>: {doc}{_SUFFIX}"
    )


def _score(query, documents, instruction):
    # One forward pass per document (batched). Returns P(yes) per document.
    prompts = [_format(query, d, instruction) for d in documents]
    with _LOCK:
        enc = _TOK(prompts, return_tensors="pt", padding=True, truncation=True,
                   max_length=MAX_LEN).to(_DEVICE)
        with torch.no_grad():
            logits = _MODEL(**enc).logits[:, -1, :]  # last-position logits
        pair = logits[:, [_NO_ID, _YES_ID]].float()
        probs = torch.softmax(pair, dim=1)[:, 1]  # P(yes)
        scores = probs.detach().cpu().numpy()
    # NaN/inf guard (mirror embed_server): a degenerate row must never emit the
    # literal "NaN" token that crashes the Node client's res.json().
    scores = np.nan_to_num(scores, nan=0.0, posinf=1.0, neginf=0.0)
    return [float(s) for s in scores]


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj, allow_nan=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "model": MODEL_ID,
                             "model_version": MODEL_VERSION, "device": _DEVICE})
        else:
            self._send(404, {"ok": False, "error": "not_found"})

    def do_POST(self):
        if self.path != "/rerank":
            self._send(404, {"ok": False, "error": "not_found"})
            return
        try:
            n = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception as e:
            self._send(400, {"ok": False, "error": f"bad_json:{e}"})
            return
        query = req.get("query")
        documents = req.get("documents")
        instruction = req.get("instruction") or DEFAULT_INSTRUCTION
        if not isinstance(query, str) or not query:
            self._send(400, {"ok": False, "error": "query_must_be_nonempty_string"})
            return
        if not isinstance(documents, list) or not all(isinstance(d, str) for d in documents):
            self._send(400, {"ok": False, "error": "documents_must_be_string_list"})
            return
        if len(documents) == 0:
            self._send(200, {"scores": [], "model_version": MODEL_VERSION})
            return
        try:
            t = time.time()
            scores = _score(query, documents, instruction)
            self._send(200, {"scores": scores, "model_version": MODEL_VERSION,
                             "count": len(scores),
                             "elapsed_ms": round((time.time() - t) * 1000, 1)})
        except Exception as e:
            self._send(500, {"ok": False, "error": f"rerank_failed:{e}"})


def main():
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
