#!/usr/bin/env bash
# GPU embed pass for assets
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
exec pnpm embed:assets "$@"
