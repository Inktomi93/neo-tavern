#!/usr/bin/env bash
#
# ── SessionStart hook (Claude Code on the web) ───────────────────────────────────────────────────
# Wired via .claude/settings.json; runs at the start of EVERY Claude Code session. Cloud-ONLY — a
# no-op locally (you manage your own deps there). It guarantees node_modules is present + current in
# the web sandbox even if the cached Setup-script install (scripts/cloud-setup.sh) didn't persist,
# and is near-instant when the store is already warm.
# ─────────────────────────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# Only run in Claude Code on the web; skip local sessions.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 24 >/dev/null 2>&1 || true
corepack enable >/dev/null 2>&1 || true

# Fast when warm (store cached by the setup script); a full install otherwise. --frozen-lockfile
# keeps it reproducible (fails if pnpm-lock.yaml is out of date rather than silently mutating it).
pnpm install --prefer-offline --frozen-lockfile
echo "neo-tavern deps ready"
