# AGENTS.md

Doctrine for AI agents (and humans) working in neo-tavern. Read this before writing code.

## What this is

A private, single-user RP frontend **and** a personal RAG/analytics layer over an
RP corpus (400+ characters, hundreds of chats). **Two co-equal goals: a polished RP
chat experience (a prettier SillyTavern — Marinara/Astra-grade) AND the corpus/RAG
superpower (the killer differentiator).** Chat is NOT incidental (stance changed,
owner-approved — see CLAUDE.md mission). Homelab-hosted behind authentik + caddy. One
user: no auth code, no multi-tenant anything, no settings pages for things with one
obvious default.

## Read first

- **`CLAUDE.md`** — the mission + RP philosophy (YGWYG, mode valve) + locked decisions.
- **`docs/architecture.md`** — the layer cake + dependency direction. Not aspirational; enforced.
- **`docs/dependencies.md`** — deferred-dependency parking lot (what to add, when, the exact command).
- **`references/README.md`** — the local domain reference clones (see below).

## The rules are enforced, not suggested

`pnpm check` = **biome + tsc + `pnpm arch` (dependency-cruiser) + vitest**. It runs
on pre-commit. Green = ship. It must pass before you call anything done.

- The **layer cake** (`shared → db → infra → domain → drivers{trpc,jobs}`; client
  `lib/state/ui → components → features → routes`) is machine-checked. Import
  "upward" or sideways and `pnpm arch` fails. Don't fight it — put the code in the
  right layer. Transport/jobs stay THIN; logic lives in `domain/<feature>`. Routes
  stay THIN; UI lives in `client/features/<feature>`.
- **Strict TS + Biome** (exhaustive `biome.jsonc`): no `any`, no non-null `!`,
  `import type` for types, no default exports outside config/route files, etc.
  **Fix the code, don't loosen the rule.** If a rule is genuinely wrong for a case,
  scope an override *and document why* in the config — never silently widen it.
  **`docs/conventions.md` is the concrete trap list** — the Biome⇄tsc index-key conflict,
  the format-before-`check` reflex, logging, the strict-TS gotchas, the vector-index quirks,
  `tsx -e`. Read it before fighting the linter; we keep re-dancing these otherwise.
- Tools are scoped to `src` (+ `scripts`/`tests`). Add a new top-level dir and you
  must confirm biome/tsc/vitest/knip/dependency-cruiser still ignore what they should.
- Don't install a dependency before it has a consumer (knip flags dead deps). Check
  `docs/dependencies.md` first.
- **Before writing a test, read `tests/AGENTS.md`.** Test behavior not
  implementation; mock only true boundaries (never the DB — use in-memory libSQL);
  no tautological "shit tests."
- **To debug the running app, `curl /api/_debug/*` — do NOT tail log files.** Grab
  `X-Request-Id` from any response, then `/api/_debug/logs?requestId=…`. Logging:
  `ctx.log` in procedures, `getLog()` elsewhere — never raw `console`, never import
  `pino` directly (both are lint errors). See `docs/observability.md`.
- **To understand/debug the Agent SDK, run `pnpm sdk:play`** (dumps the full message
  stream + config; toggles via env) — don't guess at its behavior. Map: `docs/sdk-notes.md`.

## references/ is a REFERENCE, not the bible

`references/` holds **SillyTavern, AstraProjecta, and Marinara-Engine** cloned
locally (gitignored, tool-excluded). They exist so you can **learn** — data formats,
domain concepts, what patterns worked — **not** so you can copy them.

**Exception — `references/card-curator` + `references/st-bridge` are symlinks to OUR OWN
sibling repos** (in `development/`). They are the corpus/RAG **answer keys**: validated ST
parsers + ranking we *do* port (`docs/corpus-import.md` cites them `file:line`). "Learn don't
copy" applies to the *external* refs above; for our own prior work, lift the logic + re-express
it in our layers/types. Don't re-derive what they already solved.

- **SillyTavern** is legacy jQuery / webpack / no-TypeScript. We are modern TS +
  Vite + Biome with an *enforced* architecture. Mine it for **domain knowledge**
  (character-card PNG format, world-info/lorebook structure, chat JSONL — the Phase 4
  import target). Do **not** import its code patterns.
- **Marinara / Astra** are closer in spirit, but they made their own tradeoffs on
  their own stacks. Borrow *ideas*; re-express them in our layers, our types, our rules.
- **Never** `import` from `references/`. **Never** paste their code wholesale.
  Translate the *idea* into neo-tavern's architecture.
- When a reference conflicts with our architecture or enforcement, **our architecture
  wins.** If you think ours is actually wrong, raise it as a question and propose a
  change — don't silently adopt theirs.

We are building our own thing, deliberately. The references are a map of the
territory, not the route we have to drive.

## Working norms

- Match existing patterns before inventing new ones.
- Comments explain **why**, not what.
- No slop: no theme switcher (one dark theme), no premature dashboards, no character
  editor with 47 fields before chat works. When in doubt, ask.
- Decisions already made live in `docs/`. Don't re-litigate locked choices; raise a
  question if you disagree.
