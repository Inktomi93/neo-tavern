#!/usr/bin/env bash
# GPU embed pass — self-contained, no system CUDA, no Docker.
#
# Bootstraps the project-local CUDA-12 + cuDNN-9 runtime venv (uv, tools/cuda/) if it's
# missing, puts its NVIDIA .so dirs on LD_LIBRARY_PATH, and runs the embed pass on the GPU
# (EMBED_DEVICE=cuda). onnxruntime-node 1.24's CUDA EP needs CUDA 12 + cuDNN 9 — supplied
# entirely from tools/cuda/.venv, so nothing leaks in from the host or other projects.
#
# Usage: pnpm embed:corpus:gpu [import-dir]   (DATABASE_URL selects the target DB)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CUDA_PROJ="$ROOT/tools/cuda"
VENV="$CUDA_PROJ/.venv"

if [ ! -d "$VENV" ]; then
  echo "[gpu] CUDA runtime venv missing — bootstrapping with uv (downloads CUDA 12 + cuDNN 9 wheels once)…"
  uv sync --project "$CUDA_PROJ"
fi

LDP="$(find "$VENV" -type d -path '*/nvidia/*/lib' 2>/dev/null | tr '\n' ':')"
if [ -z "$LDP" ]; then
  echo "[gpu] ERROR: no NVIDIA libs found under $VENV. Run 'pnpm cuda:setup' and retry." >&2
  exit 1
fi

export LD_LIBRARY_PATH="${LDP}${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
export EMBED_DEVICE=cuda
echo "[gpu] CUDA runtime from $VENV"
exec pnpm embed:corpus "$@"
