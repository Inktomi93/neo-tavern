#!/usr/bin/env bash
# Transient (gitignored) full corpus + memory rebuild. Re-runnable:
#   STEP 2-4 are resumable — embed-corpus skips already-embedded cards, memory:backfill --all
#   skips chats whose digests are already current. So if this dies mid-run, just re-invoke WITHOUT
#   --fresh and it picks up where it left off. Pass --fresh to wipe the DB and re-import first.
set -uo pipefail
cd "$(dirname "$0")/.."

VENV="$(pwd)/tools/cuda/.venv"
LDP="$(find "$VENV" -type d -path '*/nvidia/*/lib' | tr '\n' ':')"
export LD_LIBRARY_PATH="${LDP}${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
# Whole process confined to the FREE card (GPU 1). One visible device ⇒ llama.cpp can't straddle;
# EMBED_GPU_ID=0 because GPU 1 is remapped to index 0 inside the process.
export CUDA_VISIBLE_DEVICES=1 EMBED_DEVICE=cuda EMBED_DTYPE=fp16 EMBED_GPU_ID=0

ts() { date +%H:%M:%S; }

if [[ "${1:-}" == "--fresh" ]]; then
  echo "[$(ts)] === STEP 1/4: wipe + re-import (curated; skips Ruby + Assistant) ==="
  rm -f neo-tavern.db neo-tavern.db-shm neo-tavern.db-wal
  pnpm import:st 2>&1 | grep -E '\[import\]' || true
fi

echo "[$(ts)] === STEP 2/4: embed character cards → character_embeddings (GPU 1) ==="
pnpm exec tsx scripts/embed-corpus.ts 2>&1 | grep -E '\[embed\]' || true

echo "[$(ts)] === STEP 3/4: backfill digests + segments --all (Qwen + embedder on GPU 1, grammar JSON) ==="
LOG_LEVEL=warn pnpm exec tsx scripts/memory-backfill.ts --all 2>&1 \
  | grep -vE 'injected env|Already up to date|^\$ |Done in'

echo "[$(ts)] === STEP 4/4: CSLS hub scores ==="
pnpm exec tsx scripts/csls.ts 2>&1 | grep -E '\[csls\]' || true

echo "[$(ts)] === REBUILD COMPLETE ==="
