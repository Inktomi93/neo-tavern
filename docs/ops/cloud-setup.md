# Running neo-tavern in Claude Code on the web

How to make a cloud session at [claude.ai/code](https://claude.ai/code) come up with everything this
project needs. The web sandbox is **Ubuntu 24.04, CPU-only, 4 vCPU / 16 GB / 30 GB**, run as root.

Two mechanisms, both already version-controlled here:

| Where | File | Runs | Use for |
| --- | --- | --- | --- |
| **Setup script** (cloud UI field) | `scripts/cloud-setup.sh` | once per env build, **cached**, ~5-min budget, before Claude starts | runtimes (Node 24) + the cached dep install |
| **SessionStart hook** (in repo) | `.claude/settings.json` → `scripts/cloud-session-start.sh` | every session, no time cap, **cloud-only** | dependency install safety-net |

## One-time setup (in the claude.ai/code UI)

1. Open your neo-tavern environment → **Settings**.
2. **Setup script** field → paste the **contents of [`scripts/cloud-setup.sh`](../scripts/cloud-setup.sh)**.
   (The web setup script is stored in the cloud env, not read from the repo — the file here is the
   source of truth to copy from + keep in sync.)
3. **Environment variables** field (`.env` format, **no quotes**) → add what you need:
   ```
   OPENROUTER_API_KEY=sk-or-...        # raw/chat-completions + Claude-API (mode 2)
   DEBUG_TOKEN=<any-value>             # enables /api/_debug/* (optional)
   DEFAULT_USER_HANDLE=owner           # single-user owner identity
   ```
   ⚠️ env vars are visible to anyone who can edit the environment — there's no secret store yet.
4. **Network access**: leave **Trusted** (default) — it allowlists npm + GitHub, which covers
   `pnpm install`. See below if you need model downloads.
5. The `.claude/settings.json` SessionStart hook is already in the repo — nothing to do; it installs
   deps on each cloud session and is a no-op locally.

That's it. New sessions come up with Node 24, pnpm 11, and `node_modules` ready → `pnpm check` works.

## What works on web vs. what doesn't

✅ **Works:** `pnpm check` (biome + tsc + arch + vitest — tests use synthetic vectors, no model/GPU),
building features, the dev servers, and **OpenRouter chat** (chat-completions / responses / the
Claude-API skin — all keyed by `OPENROUTER_API_KEY`).

⚠️ **Caveats:**
- **No GPU / CUDA.** `pnpm cuda:setup`, `embed:corpus:gpu`, and the heavy corpus index pass are
  homelab-only. CPU embedding (`EMBED_DEVICE=cpu`, the default) works but is slow for bulk indexing.
- **Model downloads** (BGE-M3 / reranker for `pnpm embed:probe`) pull from `huggingface.co`, which is
  **not** in the Trusted allowlist. If you need them, set Network → **Custom** and add
  `huggingface.co` + `cdn-lfs.huggingface.co` (or use **Full**). `pnpm check` needs none of this.
- **sdk-mode chat (mode 1, the free Max sub)** authenticates via the host `claude login` credential,
  which the web sandbox doesn't have — so live sdk-mode *turns* may not run on web. Use the
  **OpenRouter** providers for live chat there (key in env). Dev/build is unaffected either way.
- **The dev DB is local-only** (`neo-tavern.db` is gitignored). A cloud session starts with an empty
  DB; migrations auto-run on first server boot. The imported corpus (309 chars) is not present on web.

## If the env build times out

The `pnpm install` in the setup script downloads native binaries (onnxruntime-node ~100s of MB). If
that exceeds the ~5-min setup budget and the env build fails, delete the `pnpm install` line from the
setup script — the SessionStart hook installs deps in-session (no time cap) as the fallback.
