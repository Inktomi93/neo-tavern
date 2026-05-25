# Reference clones (local, gitignored)

Domain reference implementations, cloned shallow for offline reading. **Not part
of neo-tavern** — the clones are gitignored (only this README is tracked) and
excluded from every tool (biome / tsc / vitest / knip / dependency-cruiser).
Read them for patterns; never import from them.

Repopulate on a fresh checkout:

```bash
mkdir -p references
git clone --depth 1 https://github.com/RivelleDays/SillyTavern-AstraProjecta references/astra-projecta
git clone --depth 1 https://github.com/Pasta-Devs/Marinara-Engine references/marinara-engine
git clone --depth 1 https://github.com/SillyTavern/SillyTavern references/sillytavern
```

| Clone | Good for |
| --- | --- |
| **astra-projecta** | Closest analog — modern shadcn/radix ST frontend redesign. Feature-sliced client, desktop/mobile shells, UI library choices. |
| **marinara-engine** | Fullstack RP engine (Fastify + React + Drizzle/libSQL + Agent SDK). Provider patterns, prompt/cache handling, build scripts. |
| **sillytavern** | The canonical domain reference — character-card PNG format, world-info/lorebook structure, chat JSONL. The Phase 4 import target. |

Update a clone: `git -C references/<name> pull`.
