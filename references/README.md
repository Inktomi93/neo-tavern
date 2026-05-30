# Reference clones (local, gitignored)

Domain reference implementations, cloned shallow for offline reading. **Not part
of neo-tavern** — the clones are gitignored (only this README is tracked) and
excluded from every tool (biome / tsc / vitest / knip / dependency-cruiser).
Read them for patterns; never import from them.

Two kinds live here: **cloned external** frontend/domain refs, and **symlinks to our own
sibling repos** in `development/` (card-curator, st-bridge — the corpus/RAG answer-keys). Both
are gitignored; only this README is tracked.

Repopulate on a fresh checkout:

```bash
mkdir -p references
# external clones (read for patterns):
git clone --depth 1 https://github.com/RivelleDays/SillyTavern-AstraProjecta references/astra-projecta
git clone --depth 1 https://github.com/Pasta-Devs/Marinara-Engine references/marinara-engine
git clone --depth 1 https://github.com/SillyTavern/SillyTavern references/sillytavern
# our own CardRefinery — cloned (not a local sibling): the answer-key for the FUTURE refinery feature.
git clone --depth 1 https://github.com/Inktomi93/SillyTavern-CardRefinery references/card-refinery
# our own sibling repos (in development/) — SYMLINKED, not cloned:
ln -sfn ../../card-curator references/card-curator
ln -sfn ../../st-bridge   references/st-bridge
```

| Ref | Kind | Good for |
| --- | --- | --- |
| **astra-projecta** | clone | Closest analog — modern shadcn/radix ST frontend redesign. Feature-sliced client, desktop/mobile shells, UI library choices. |
| **marinara-engine** | clone | Fullstack RP engine (Fastify + React + Drizzle/libSQL + Agent SDK). Provider patterns, prompt/cache handling, build scripts. |
| **sillytavern** | clone | Canonical domain reference — character-card PNG format, world-info/lorebook, chat JSONL. The Phase 4 import target. |
| **guided-generations** | clone | ST extension (Samueras) — the **steering-UX** answer-key for backlog `#50`: guided response/swipe/impersonate + rewrite/edit-intro. Read the *what* (ephemeral inject → generate; rewrite = variant-under-instruction); SKIP the *how* (it's QR/STscript, our OUT). Owner uses response/swipe/impersonate/rewrite only. |
| **card-refinery** | clone | **Our** CardRefinery — the answer-key for the FUTURE `domain/refinery` + `features/refinery` feature (owner-planned). The Score → Rewrite → Analyze pipeline (evaluate/fix/refine cards while preserving personality); **already TypeScript + domain-sliced** (`src/domain/{pipeline,character,schema}`, `ui`, `state`, `data`) so the **pipeline logic** lifts cleanly into our layers. The schema already anticipates it: `character_versions.refineryScore`/`refineryAnalysis` + copy-on-write versioning. ⚠️ Its state layer is a hand-rolled React+Zustand mess with known state issues — port the `domain/pipeline`+`domain/schema` brain, REBUILD state/UI fresh. |
| **card-curator** | symlink | **Our** Python ST corpus tool — the deep RAG **answer key**: PNG card + chat parsers, CSLS hubness, segmentation, field budgeting. Lift `file:line` per `docs/corpus-import.md`. |
| **st-bridge** | symlink | **Our** ST bridge — lifted/improved date + branch parsers (`dates.py`), in-process CSLS (`embeddings.py`). |

Update a clone: `git -C references/<name> pull`. (Symlinks track the live sibling repos.)
