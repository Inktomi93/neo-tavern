#!/usr/bin/env bash
#
# ── Claude Code on the web — ENVIRONMENT SETUP SCRIPT ─────────────────────────────────────────────
# Paste the contents of this file into claude.ai/code → (your environment) → Settings → "Setup
# script". It runs ONCE per environment build, is CACHED, has a ~5-minute budget, and runs BEFORE
# Claude launches. It is NOT run for local sessions — it lives here only for version control so the
# cloud env stays reproducible. Per-session dependency installs are the SessionStart hook
# (.claude/settings.json → scripts/cloud-session-start.sh).
#
# Why this is needed: the web base image (Ubuntu 24.04) ships Node 20/21/22 via nvm, but neo-tavern
# requires Node >=24 (.nvmrc pins 24, package.json engines). So we install 24 here.
#
# NOT set up here (on purpose): CUDA / uv / `pnpm cuda:setup`. The web sandbox is CPU-only (no GPU),
# so EMBED_DEVICE stays "cpu" (the default) and GPU corpus embedding is homelab-only. `pnpm check`
# uses synthetic vectors, so it needs no model download or GPU.
# ─────────────────────────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# 1) Node 24 via nvm (preinstalled on the web base).
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm install 24
nvm alias default 24
nvm use 24

# 2) pnpm 11 via corepack (exact version pinned in package.json "packageManager").
corepack enable
corepack prepare pnpm@11.3.0 --activate

# 3) Install dependencies into the cached env image so subsequent sessions start warm.
#    Native builds (onnxruntime-node, esbuild, protobufjs) are pre-approved in pnpm-workspace.yaml.
#    NOTE: if this download/build exceeds the ~5-min setup budget and the env build times out, delete
#    this line — the SessionStart hook (scripts/cloud-session-start.sh) installs deps in-session
#    (no time cap) as a fallback.
pnpm install --frozen-lockfile

node -v && pnpm -v && echo "neo-tavern cloud setup OK"
