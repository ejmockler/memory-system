#!/usr/bin/env python3
# smoke_test.py — load the embedding model unquantized via sentence-transformers
# on the local accelerator, embed a handful of synthetic sample sentences,
# measure throughput, and confirm the output contract (dim, L2 norm) the
# memory-system needs.
#
# Env: EMBED_MODEL (default Qwen/Qwen3-Embedding-8B) and EMBED_DEVICE (unset =
# auto-detect mps, then cuda, then cpu) — the same knobs as embed_server.py.

import os, time, sys
import torch
from sentence_transformers import SentenceTransformer

MODEL = os.environ.get("EMBED_MODEL", "Qwen/Qwen3-Embedding-8B")


def _resolve_device(requested):
    if requested:
        return requested
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


DEVICE = _resolve_device(os.environ.get("EMBED_DEVICE", "").strip().lower())
# fp16 on a GPU backend, fp32 on CPU (same rule as embed_server.py).
HALF = DEVICE.startswith(("mps", "cuda"))
DTYPE = torch.float16 if HALF else torch.float32

print(f"loading {MODEL} ({'fp16' if HALF else 'fp32'}, device={DEVICE}) ...", flush=True)
t0 = time.time()
model = SentenceTransformer(
    MODEL,
    model_kwargs={"torch_dtype": DTYPE},
    tokenizer_kwargs={"padding_side": "left"},
    device=DEVICE,
)
load_s = time.time() - t0
native_dim = model.get_sentence_embedding_dimension()
print(f"  loaded in {load_s:.1f}s | native dim = {native_dim}", flush=True)

# Synthetic samples with a realistic length mix: short commit-style lines, one
# long technical sentence, one chat-style line. None is taken from real data.
docs = [
    "parser: update to the latest version",
    "adding the example widget module to version control",
    "The plan is to focus on the remaining calibration uncertainty: the inlet and outlet fittings are modeled",
    "The workflow-level condition requires the pull request head repository to equal example-org/example-repo and the author to match the allow list",
    "Tomorrow is the team lunch, remember to bring the sample cake",
    "we can use a code generator and a shared design system to produce pages very quickly",
    "user: Review this example project layout and list the structural problems.",
    "Local signing",
]

# Warm-up (first call compiles Metal kernels).
_ = model.encode(docs[:2], batch_size=2, normalize_embeddings=True, convert_to_numpy=True)

# Throughput: documents (no instruction prompt).
for bs in (8, 32, 64):
    corpus = (docs * ((bs // len(docs)) + 1))[:bs]
    t = time.time()
    emb = model.encode(corpus, batch_size=bs, normalize_embeddings=True, convert_to_numpy=True)
    dt = time.time() - t
    rate = bs / dt
    import numpy as np
    norms = np.linalg.norm(emb, axis=1)
    print(f"  batch={bs:3d}: {dt*1000:7.1f}ms total | {rate:7.1f} embeds/sec | dim={emb.shape[1]} | L2 in [{norms.min():.4f},{norms.max():.4f}]", flush=True)

# Larger sustained batch to estimate steady-state throughput.
big = (docs * 32)[:256]
t = time.time()
emb = model.encode(big, batch_size=64, normalize_embeddings=True, convert_to_numpy=True)
dt = time.time() - t
print(f"  SUSTAINED batch=256 @ bs64: {dt:.2f}s | {256/dt:.1f} embeds/sec", flush=True)

# MRL check: Qwen3-Embedding supports Matryoshka truncation. Confirm we can get
# a 768-dim view (what the HNSW currently uses) by truncate_dim.
try:
    m768 = SentenceTransformer(MODEL, model_kwargs={"torch_dtype": DTYPE},
                               tokenizer_kwargs={"padding_side": "left"},
                               device=DEVICE, truncate_dim=768)
    e768 = m768.encode(docs[:2], normalize_embeddings=True, convert_to_numpy=True)
    import numpy as np
    print(f"  MRL-768: dim={e768.shape[1]} | L2={np.linalg.norm(e768, axis=1)}", flush=True)
except Exception as e:
    print(f"  MRL-768 truncate check skipped: {e}", flush=True)

# Query-side uses an instruction prompt (asymmetric retrieval).
q = model.encode(["what did we change in the example calibration routine last week"],
                 prompt_name="query", normalize_embeddings=True, convert_to_numpy=True)
print(f"  query embed: dim={q.shape[1]} OK", flush=True)
print("SMOKE_OK", flush=True)
