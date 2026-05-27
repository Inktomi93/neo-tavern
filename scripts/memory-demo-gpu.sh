#!/usr/bin/env bash
# Run the {{memory}} digest demo with the embedder + reranker WARM ON GPU (the 2× A6000s),
# using the project-local vendored CUDA-12/cuDNN-9 runtime (tools/cuda, pnpm cuda:setup) on
# LD_LIBRARY_PATH. The reranker (bge-reranker-v2-m3-ONNX) is fp16-only and FAILS on the CPU EP,
# so GPU isn't optional here — and the embedder is far faster on GPU anyway.
#
# Usage: bash scripts/memory-demo-gpu.sh {build|show|query "q1" "q2" …}
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$ROOT/tools/cuda/.venv"
if [ ! -d "$VENV" ]; then
  echo "[gpu] CUDA runtime venv missing — run 'pnpm cuda:setup' first." >&2
  exit 1
fi

LDP="$(find "$VENV" -type d -path '*/nvidia/*/lib' 2>/dev/null | tr '\n' ':')"
if [ -z "$LDP" ]; then
  echo "[gpu] ERROR: no NVIDIA libs under $VENV. Run 'pnpm cuda:setup' and retry." >&2
  exit 1
fi

export LD_LIBRARY_PATH="${LDP}${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
# Both warm on GPU. Embedder is fp16-on-CUDA (same vector space as cpu-fp32 — safe), reranker
# fp16-on-CUDA (its only option). For the bulk corpus pass you'd split embed→card0 / rerank→card1
# via CUDA_VISIBLE_DEVICES; query-time embed→rerank is sequential, so one card is fine.
export EMBED_DEVICE=cuda EMBED_DTYPE=fp16
export RERANK_DEVICE=cuda RERANK_DTYPE=fp16
echo "[gpu] embedder+reranker on CUDA from $VENV"
exec ./node_modules/.bin/tsx scripts/memory-demo.ts "$@"
