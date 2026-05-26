# Agent SDK field notes

Map of `@anthropic-ai/claude-agent-sdk` (v0.3.x) so we build *with* it, not against
it. The lesson from `st-claude-proxy`: reverse-engineering a black box by trial is
miserable. So: **run the playground, watch it, then build.**

## The playground — `pnpm sdk:play`

Fires one query with max observability and dumps **every message the SDK emits**,
in order, with timing. Toggle knobs via env:

```bash
pnpm sdk:play                                   # lean (haiku, no tools/mcp/settings)
DEBUG=1 pnpm sdk:play                            # + SDK --debug logging via the stderr callback
TOOLS=1 pnpm sdk:play                            # let it use built-in tools (watch the lifecycle change)
MCP=1 SETTINGS=1 pnpm sdk:play                   # load YOUR ~/.claude mcp servers + plugins/hooks
FULL=1 pnpm sdk:play                             # full message JSON (not truncated)
PROMPT="…" MODEL=claude-opus-4-7 pnpm sdk:play   # any prompt/model
```

Auth = host `claude login` (Max sub), same as the real provider.

## The message stream (what `query()` yields)

`query()` returns `Query extends AsyncGenerator<SDKMessage>`. A lean turn looks like:

```
system/init  →  system/status  →  stream_event × N  →  assistant  →  result/success
```

Message `type`s you'll see (30+ in the union): `system` (`init` = full config,
`status`), `stream_event` (partial/streaming deltas), `assistant`, `user`,
`result` (`success` | `error*`), `rate_limit_event`, `api_retry`, the hook events
(`hook_started`/`progress`/`response`), task events (`task_started`/`updated`/
`progress`/`notification`), `tool_progress`, `tool_use_summary`,
`compact_boundary`, `session_state_changed`, `memory_recall`, `permission_denied`.

- **`system`/`init`** — the SDK's self-report: `model`, `tools`, `mcp_servers`,
  `slash_commands`, `skills`, `agents`, `permissionMode`, `apiKeySource`
  (`"none"` = subscription), `claude_code_version`, `cwd`, `session_id`.
- **`result`** — `is_error`, `num_turns`, `duration_ms`, `total_cost_usd`,
  `usage` + `modelUsage` (per-model in/out/cache tokens, costUSD, contextWindow),
  `terminal_reason`.

## The knobs (`options`, ~60) — grouped

- **Model / generation:** `model`, `fallbackModel`, `maxTurns`, `maxThinkingTokens`,
  `thinking`, `effort`, `outputFormat`.
- **Session (YGWYG + escape valve):** `resume` (sessionId — *the* YGWYG primitive),
  `resumeSessionAt`, `continue`, `forkSession` (+ the `forkSession()` fn — fork-and-convert),
  `sessionId`, `persistSession`, `sessionStore`, `sessionStoreFlush`, `title`.
- **Tools / permissions:** `tools` (`[]` = none, or `claude_code` preset), `allowedTools`,
  `disallowedTools`, `toolAliases`, `toolConfig`, `canUseTool` (intercept each call),
  `permissionMode`, `permissionPromptToolName`, `allowDangerouslySkipPermissions`, `sandbox`.
- **Context / prompt:** `systemPrompt`, `settingSources` (`[]` = ignore ~/.claude
  settings/plugins), `settings`, `managedSettings`, `mcpServers`, `strictMcpConfig`,
  `plugins`, `skills`, `agents`, `betas`.
- **Budget:** `maxBudgetUsd`, `taskBudget`.
- **Process / env:** `env` (REPLACES subprocess env — spread `process.env`),
  `cwd`, `additionalDirectories`, `pathToClaudeCodeExecutable`, `executable`,
  `executableArgs`, `extraArgs`, `abortController`, `loadTimeoutMs`,
  `spawnClaudeCodeProcess`.
- **Observability / debug (the point of this doc):**
  - `debug: true` — verbose `--debug` logging (to `stderr` or `debugFile`).
  - `debugFile: "<path>"` — write debug logs to a file.
  - `stderr: (data) => …` — callback for ALL subprocess stderr (the raw chatter).
  - `hooks: { <HookEvent>: [...] }` — register callbacks on 29 lifecycle events.
  - `includeHookEvents: true` — emit hook events INTO the message stream (no callback needed).
  - `includePartialMessages: true` — stream token deltas (`stream_event`).
  - `agentProgressSummaries`, `forwardSubagentText` — subagent visibility.
  - `enableFileCheckpointing`, `onElicitation`, `promptSuggestions`.

## Hooks — 29 lifecycle events

`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`,
`UserPromptSubmit`, `UserPromptExpansion`, `SessionStart`, `SessionEnd`, `Stop`,
`StopFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`,
`PermissionRequest`, `PermissionDenied`, `Setup`, `TeammateIdle`, `TaskCreated`,
`TaskCompleted`, `Elicitation`, `ElicitationResult`, `ConfigChange`,
`WorktreeCreate`, `WorktreeRemove`, `InstructionsLoaded`, `CwdChanged`, `FileChanged`.

Set `includeHookEvents: true` to watch them flow through the stream, or register
`hooks` callbacks to intercept.

## Query control methods (mid-flight)

The `Query` object (streaming mode): `interrupt()`, `setPermissionMode(mode)`,
`setModel(model)`.

## Observing injection (the proxy's plugin-leak lesson)

In `st-claude-proxy`, the superpowers plugin's `SessionStart` hook silently
injected ~3.4k tokens into every request. To catch that class of bug **without
asking the model** — three signals, in order of effort:

1. **The input-token canary.** A lean turn is ~160 input tokens. Measured: lean
   `settingSources:[]` = **152–162**; with host settings/plugins loaded
   (`SETTINGS=1`) = **1343**. Injection inflates the number, visibly. This lands
   permanently in the `messages` token columns + `/api/_debug`, so an anomalous
   turn stands out.
2. **`DEBUG=1 pnpm sdk:play` — the injection audit.** Reads the SDK `debugFile`
   and prints what was actually loaded: `Registered N hooks from M plugins`,
   `plugin skills loaded: N`, `plugin commands loaded: N`, plus every API request
   and its `source` (it even exposed a hidden `generate_session_title` call). With
   our config you'll see `0 hooks, 0 plugin skills` — proof nothing leaked.
3. **The literal request body isn't in the logs — but the SDK has an escape
   hatch.** `debug`, the `stderr` callback, `debugFile`, and `ANTHROPIC_LOG=debug`
   all log request *metadata* (endpoint, source, request id) but never the
   assembled system prompt / messages. To see the literal bytes the SDK exposes
   `sandbox.network.tlsTerminate` (`sdk.d.ts:5087`, `[EXPERIMENTAL]`): in-process
   TLS termination so a per-request filter sees the HTTPS request body — no
   external proxy. Not wired up (the canary + audit make it rarely necessary), but
   it's the supported path when we need the exact `cache_control` placement.

Bottom line: the provider config (`settingSources:[]`, `mcpServers:{}`,
`tools:[]`, `CLAUDE_CODE_DISABLE_CLAUDE_MDS=true`) holds injection at the floor,
and the canary + audit *prove* it stayed there.

## Conversational contract (validated — `pnpm sdk:contract`)

The behavioral assumptions neo-tavern's design hinges on, checked live against the
SDK (a runnable probe, not a unit test — it costs sub queries; re-run after SDK
upgrades). All currently hold:

- **`systemPrompt` drives the character.** The card → persona. ✅
- **Context tracks across a *multi-turn* conversation.** A 5-turn run establishes
  four facts, then turn 5 recalls **the earliest** — proves the session
  accumulates and holds canon, not just a 1→2 resume (the trap: short tests pass
  while long conversations silently drop early context). ✅
- **A session transcript is `user | assistant | system`.** Assistant turns live in
  the *session*, not the prompt. ✅

**The load-bearing consequence — how the character greeting + imported chats work:**
the live `prompt` input is **type-locked to user messages** (`SDKUserMessage`), so
you **cannot** hand the SDK an assistant turn directly. The character's first
message (an assistant turn that the model didn't generate) and imported ST chats
(full user/assistant history) must be **seeded into the session transcript** —
`InMemorySessionStore` / `importSessionToStore` + `getSessionMessages`, then
`query({ options: { resume: sessionId, sessionStore } })`. That's the mechanism
`domain/chat` will build on (nailing the exact transcript-entry shape is a Phase 2
task — capture a real one via the store to get the format).

## Caching (validated — `CACHE=1 pnpm sdk:play`)

**Caching has to work — verified what we can control and what we can't, then measured it.**

**What we control.** The SDK's one typed knob is `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`
(`sdk.d.ts:1808`) — a marker in a `string[]` `systemPrompt` that splits the static
(cacheable) prefix from the dynamic suffix. The runtime owns cache_control
*placement* AND the TTL — and the TTL is **NOT env-controllable.**

> ⚠️ **CORRECTION (supersedes an earlier claim in this doc).** There is **no
> `FORCE_PROMPT_CACHING_5M` / `ENABLE_PROMPT_CACHING_1H` / `DISABLE_PROMPT_CACHING`
> env knob** that we set to steer TTL — that was wrong (a `strings`-on-the-binary
> guess that didn't pan out). The agent-sdk runtime places `cache_control` itself and
> uses its **own internal TTL** (the `extended_cache_ttl` beta, effectively ~1h). We do
> NOT set any caching env var in `buildClaudeSdkEnv()`, and shouldn't.

**Effective TTL is ~1h** (SDK-internal). For human-paced RP that's the right behavior:
step away 40 min, come back, and the character/system prefix is still a cache hit. On
the **free Max sub** this is allowance, not dollars. For **paid Claude** the 1h *write*
costs ~2× the 5m rate, so mode 2 (agent-sdk + openrouter) inherits that ~2× — which is
exactly why the cost-controlled paid-Claude path is **mode 3** (chat-completions +
openrouter), where the openrouter runner places an explicit 5m `cache_control` directive
we control (see the OpenRouter section below).

**The TTL is provable from the response, no waiting:** `result.usage.cache_creation`
carries `{ ephemeral_5m_input_tokens, ephemeral_1h_input_tokens }` (runtime-exposed
though the `.d.ts` doesn't type it). Worth recording into the `messages` token
columns alongside `cache{Creation,Read}InputTokens`.

Anthropic caching is a **prefix cache**: it matches from the start of the prompt
forward and stops at the first divergence — so a mutation's cost is proportional
to how far from the *end* it happens. Measured (Haiku, ~4.6k-token static lore, a
per-run nonce so each invocation writes its own cache):

| turn | usage | meaning |
|---|---|---|
| 1 fresh | `cacheCreate≈4674 cacheRead=0` | the runtime caches our custom system prompt (default to the 1h bucket) |
| 2 resume (full) | `cacheRead≈4674 input=10` | resume across a separate subprocess hits — prompt assembly is **deterministic**, only the new message is fresh |
| 3 resume (truncated to turn 1) | `cacheRead≈4674` | a **fork/swipe keeps the cached prefix**; only the ~200-token tail re-caches |

Consequences for the design:
- **Append (normal YGWYG turn)** and **swipe (regen last turn)** and **fork from a
  point** all branch at/after a cached prefix → cache-cheap. Confirmed for fork.
- **Editing a buried turn** diverges the prefix at the edit point → everything after
  re-caches (cost ∝ tail length). **Now measured** (`EDIT=1 pnpm sdk:play`): editing
  the earliest text frame dropped `cacheRead` 5664→4688 (collapsed to the bare system
  prefix) and pushed `cacheCreate` 232→1186 (the whole ~976-token tail re-cached);
  editing the **last** frame cost ~0 (`cacheRead` unchanged). Edit cost ∝ distance
  from the end.
- The expensive static prefix (character/system) is paid **once** and read free
  thereafter, including across forks — so YGWYG's append-only path is also the
  cache-optimal path.

Not covered by this probe (honest gaps): **actual TTL expiry** (proved which bucket
via `cache_creation`, didn't wait out the window — a chat reopened after it is a
cold first turn regardless); **raw-mode** (separate path, our own `cache_control`).
Numbers are Haiku-specific; mechanics are model-independent.

## Spawn latency & the session model (measured — `LATENCY=1 pnpm sdk:play`)

Cold one-shot resume (a fresh subprocess per message — the proxy model) vs a warm
streaming session (one held subprocess), isolating spawn as `overhead = wall − api`:

| path | overhead/msg (steady-state) | meaning |
|---|---|---|
| **COLD** (`query({resume})` per msg) | **~0.8s** | spawn + session-materialize, paid every message |
| **WARM** (one streaming session) | **~5ms** | `wall ≈ api`, no spawn — paid once at open |

**Decision: sdk-mode is STATELESS — one `query({ resume, sessionStore })` per
message.** The 0.8s rides on top of multi-second generation; our *lean* spawn already
beats the proxy's plugin-bloated one; and stateless means no subprocess lifecycle to
manage and trivial editing (every turn already resumes from a chosen branch point, so
"click another character" is just a DB read — nothing warm to tear down). A warm
session (~0.78s saved/msg, proven via the streaming `InputQueue` in the probe) is a
**future drop-in optimization**, not built — the warm pool would be premature. Caveat:
0.8s is spawn+materialize on a 4-turn transcript; re-measure on long chats (bigger
`session_entries` → bigger temp-JSONL materialize).

## Edits / swipes — capability vs. discipline (resolved)

The brief's "no edits in sdk-mode" was a *discipline*, not a limit — **proven, not
assumed.** Because `load()` feeds the subprocess whatever transcript we return, and
`getSessionMessages()` reads it back, we have full read/write over the transcript:

- **Fork / swipe** (drop trailing frames, resume) — *executed live* in the CACHE
  probe; cache prefix survives.
- **Edit a buried frame** (change content, resume) — the identical `load()` mechanism;
  *executed live* in the `EDIT` probe. It resumes coherently, and its **cache cost is
  measured**: a buried edit re-caches the entire tail after it (~976 tokens in the
  probe), a tail edit costs ~0. So editing late is cheap, editing deep is not.
- **Can't edit inside a warm session** (the live subprocess already "saw" the
  original); an edit = mutate `session_entries` + fresh resume from the branch point.
  In stateless mode that's just the normal path, so edits are free to bolt on.

So swipes/edits get a home as **branched sessions** (a new session forked at a `seq`,
original intact) whenever we choose to expose them — sdk-mode stays YGWYG by default,
raw-mode is where they're cache-cheap.

## How this maps to neo-tavern

- **sdk-mode chat** = **stateless** `query({ prompt, options: { resume: chat.sessionId,
  sessionStore: dbStore } })` per message; persist `result.session_id` on the chat row.
- **Escape-valve fork / swipe** = `forkSession(sessionId)` (or resume from a truncated
  `session_entries` slice) → new branched session, original preserved.
- **Token/cost accounting** for the `messages` table = the `result.modelUsage` block.
- **Streaming to the client** = forward `stream_event` deltas.
- **Debugging a bad turn** = `DEBUG=1 pnpm sdk:play` with the offending prompt, or
  the app's own `/api/_debug` (see `observability.md`).

## The chat runtime — which SDK events we handle (implemented, Phase-5 prepwork)

`query()` yields a 30-member `SDKMessage` union; a daily-driver RP chat must do more
than scrape the reply. `runChatTurn` spawns + resumes, then delegates the whole
stream to **`consumeTurnStream(stream, ctx)`** (exported, in `providers/claude-sdk.ts`)
— split out so the mapping is unit-testable with a hand-built stream (no subprocess;
see `claude-sdk.test.ts`). It returns a `ChatTurnResult` and **throws `TurnError`
on any failure result.**

| SDK message | What we do | Surfaced as |
|---|---|---|
| `assistant` (text blocks) | accumulate the reply, capture `stop_reason` | `result.reply` |
| `result` success | sum `modelUsage` (tokens/cost/**contextWindow**/maxOutputTokens), read `usage.cache_creation` 5m/1h split, `ttft_ms`, `terminal_reason`, `api_error_status` | `result.usage` + columns |
| `result` error (`error_during_execution`/`max_turns`/`max_budget_usd`/`max_structured_output_retries`) | classify → **throw `TurnError`** | typed error |
| `system`/`compact_boundary` | record trigger/pre·post-tokens; **INFO log** (stream event — the persisted frame is separate, see below) | `events[].compaction` |
| `system`/`api_retry` | record attempt/delay/code; **WARN** (or **ERROR** if the code is an auth failure — the ban canary) | `events[].api_retry` |
| `system`/`status` | record `SDKStatus` + `compact_result` | `events[].status` |
| `rate_limit_event` | snapshot status/resetsAt/type; **WARN** when throttled/rejected | `events[].rate_limit` + `result.rateLimit` |
| `auth_status` | **WARN unconditionally** — auth changing mid-turn is the ban-risk canary | `events[].auth_status` |
| `system`/`init` | apiKeySource etc. — the input-token canary on the result is the durable signal | (debug) |
| `stream_event` | no-op (we don't set `includePartialMessages` yet — see below) | — |
| tool / task / hook / memory / permission / plugin / mirror_error / … | can't fire with our locked config (`tools:[]`, no MCP, no subagents); **logged at debug, never crash** | (debug) |

**`TurnError` is provider-agnostic on purpose.** Its `kind`
(`rate_limit | auth_failed | billing | invalid | model_unavailable | server | max_output
| aborted | unknown`) + `retryable` + `resetsAt` are the **single vocabulary the transport
and UI key off** — the raw-mode (OpenRouter/direct) adapter in Phase 5 maps its own
failures onto the *same* `kind`s, so the error surface never gets re-derived per provider.
The raw SDK code (`sdkError`, `resultSubtype`) rides along as a side detail. `domain/chat`
catches it, **rolls the user message back out** (atomic send — the chat returns to its prior
tip), and returns `SendResult{ status:"error", code, retryable, resetsAt? }`.

**Per-turn metadata persists** on `messages` (migration 0008): `contextWindow`,
`maxOutputTokens`, `cacheCreation5mTokens`/`1h`, `ttftMs`, `terminalReason`,
`apiErrorStatus` — the context-fill meter + latency UX + analytics axes.

**Compaction — MEASURED, not assumed** (`pnpm sdk:compaction`; force it cheaply with
`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` — auto-compact triggers at a *percentage* of the model's
context window, not a token count). What actually happens on a long chat:
- The `compact_boundary` arrives as a **stream event** (we log it + record `events[].compaction`).
  Its `compact_metadata` in practice carries only `trigger`/`pre_tokens`/`post_tokens`/`duration_ms`
  — **no `preserved_messages` relink** (that field exists in the type but was absent in every
  real compaction observed).
- What's **persisted** to the store is *not* a "compact_boundary"-typed frame — it's a
  `type:"system", subtype:"compact_boundary"` marker (content `"Conversation compacted"`,
  camelCase `compactMetadata`) that **resets the chain root** (`parentUuid:null`; old frames kept
  only via `logicalParentUuid`) — so the boundary literally becomes "the start of the conversation"
  — **plus a synthetic `user` frame** holding a real LLM-generated prose summary ("This session is
  being continued from a previous conversation…"). Compaction costs an LLM call (~6–20s).
- Old pre-compaction frames stay in the store; resume uses the compacted state (~`post_tokens`) and
  does **not** re-compact every turn. `DbSessionStore` round-trips these real frames in `seq` order
  (`chat-session-store.test.ts`).
- ⚠️ **Fidelity caveat for tool-less RP — but it's controllable.** *Auto* compaction uses NULL/default
  instructions: a generic coding-agent summary that even ends with "read the full transcript at
  `/tmp/claude-resume-*.jsonl`" (an affordance the model can't use with `tools:[]`), so specific early
  details recall unreliably. **BUT the compaction prompt is steerable** (verified):
  - **Manual `/compact <instructions>`** (send as the turn prompt) → `trigger:"manual"`; the instructions
    steer the summary. "Preserve the badge number 4471-DELTA" survived *and* was recalled on resume. The
    instructions guide rather than replace CC's template (the coding skeleton + `/tmp` line persist), but
    the facts you name survive — so the lossiness was the default prompt, not a hard limit.
  - **`DISABLE_AUTO_COMPACT=1`** (env, verified) suppresses auto-compaction; **`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=N`**
    (env, verified) fires it at N% of the window. Candidates from the env finder (`DISCOVER=compact|context`,
    unverified): `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `DISABLE_COMPACT`,
    `CLAUDE_CODE_DISABLE_1M_CONTEXT`, `USE_API_CONTEXT_MANAGEMENT`.
  - **The lever:** `DISABLE_AUTO_COMPACT=1` + we trigger manual `/compact <RP-tuned instructions>` when
    `contextWindow` (captured per turn) fills → RP-grade steered compaction on the free sub, a middle path
    between accepting lossy auto-compaction and fully owned context (raw mode / custom `load()`). Not baked
    into `buildClaudeSdkEnv()` — a build decision for the compaction-strategy work. (`pnpm sdk:compaction`)

That probe also confirmed **seeding a session from frames works** (raw→sdk / import) — but the
resume `sessionId` must be a **valid UUID** (an arbitrary string is rejected) and the frame shape is
the full structure above (`queue-operation`/`user`/`ai-title`/two `assistant`/`last-prompt` per turn,
with `parentUuid` chains), not just user/assistant turns.

(Separately, the store test pinned a real bug: the uuid-dedup unique index is defeated by a NULL
`subpath` because SQLite treats NULLs as distinct, so the main transcript now stores `""` not NULL.)

**Deferred (no consumer yet):** token-delta streaming (`includePartialMessages` +
`stream_event` parsing) — the `onEvent` sink is wired as the seam, but delta-forwarding
lands with the SSE chat UI. A persisted `chat_events` table — the log ring + `events[]`
return suffice until the UI needs history.

## Observed shapes & the compaction control surface (measured — `pnpm sdk:compaction`)

The concrete reference for building on this (haiku; *shapes* are model-independent). **Two channels,
don't conflate them:** *SessionStore frames* = what `append()` receives and we persist to
`session_entries` (the resume substrate); *stream messages* = the `SDKMessage`s `query()` yields to
`consumeTurnStream` (observability + the reply). Same concept (e.g. compaction) appears in BOTH, with
different shapes/casing.

### SessionStore frames the SDK writes, per turn

| frame `type` | per turn | `uuid`? | key fields | what it is |
|---|---|---|---|---|
| `queue-operation` | 2 | no | `operation` (enqueue/dequeue), `timestamp`, `sessionId` | internal queue marker |
| `user` | 1 | yes | `parentUuid`, `promptId`, `message{role,content}`, `permissionMode`, `cwd`, `gitBranch`, `version` | the user turn |
| `assistant` | 2 | yes | `parentUuid`, `message{model,id,content,stop_reason}`, `requestId` | **one thinking frame + one text frame** |
| `ai-title` | 0–2 | no | `aiTitle`, `sessionId` | auto chat title (intermittent; repeats/updates) |
| `last-prompt` | 1 | no | `lastPrompt`, `leafUuid`, `sessionId` | resume bookmark |

- Frames link via a **`parentUuid` chain** (each → the prior frame's uuid).
- uuid-less frames (`queue-operation`/`ai-title`/`last-prompt`) bypass our dedup index → always insert.

### Seeding a session from canon — MEASURED (`pnpm exec tsx scripts/seed-probe.ts`, Haiku + Sonnet)

This is how raw→sdk fork + ST-import continuation + greeting seeding work: synthesize frames from
plain canon (role + text) and resume. **The earlier "must reproduce the whole structure" claim was
wrong — measured, the minimal viable shape is much smaller** (`domain/chat/seed.ts` `buildSeedFrames`):

- **Bare frames are REJECTED** — `type`/`uuid`/`parentUuid`/`message` alone (even with a rich
  `message{model,id,stop_reason}`) → the SDK errors `"No conversation found with session ID …"`.
- **The load-bearing piece is per-frame METADATA**: `sessionId` (stamped on every frame) +
  `isSidechain`/`cwd`/`version`/`userType` + `promptId` (user) / `requestId` (assistant) + `timestamp`.
  Add that → resume works and the model recalls a seeded fact. ✓
- **NOT needed** (the SDK writes them, but seeding without them resumes fine): the `thinking`
  assistant frame, the dual-assistant-frame split (one text frame/turn suffices), `ai-title`,
  `queue-operation`, and even the `last-prompt` bookmark.
- The resume `sessionId` must be a real **uuidv4** (arbitrary strings are rejected).
- `cwd`/`version` are arbitrary-but-present (part of the proven bundle) — re-run the probe if the SDK
  is upgraded.
- **Greeting (assistant-first) — the ST "invisible user" trick.** A session can't sensibly start with
  a lone assistant frame: without a character system prompt the model REFUSES to own a planted
  assistant message ("I shouldn't pretend I said…"). The fix (validated, both models): **a CHARACTER
  system prompt + a NATURAL in-RP follow-up** make the model own the greeting; we also prefix a
  SESSION-ONLY invisible user stub (`GREETING_USER_STUB`) so the seed is the validated user→assistant
  shape. The stub is never a `messages` row (the UI never shows it). So greetings are seeded into
  sdk sessions, AND work for free in raw-mode (canon rebuild includes the greeting message row).

### Compaction frames (persisted to the store)

| frame | shape |
|---|---|
| boundary | `{type:"system", subtype:"compact_boundary", content:"Conversation compacted", parentUuid:null, logicalParentUuid:<last user uuid>, compactMetadata:{trigger,preTokens,postTokens,durationMs}, uuid, slug, …}` |
| summary | a `user` frame whose `message.content` = *"This session is being continued from a previous conversation… Summary: …"* (the LLM summary prose) |

- `parentUuid:null` on the boundary **resets the chain root** — it becomes "the start of the convo";
  pre-compaction frames stay in the store but hang off `logicalParentUuid` only.
- **Casing split:** persisted frame is **camelCase** (`compactMetadata.preTokens`); the *stream* message
  is **snake_case** (`compact_metadata.pre_tokens`). `preserved_messages`/`preserved_segment` are typed
  but were **absent** in every compaction observed.

### Turn message stream (what `query()` yields)

| turn | order (minus `stream_event` deltas) |
|---|---|
| normal | `system/init → [rate_limit_event] → assistant(thinking) → assistant(text) → result/success` |
| auto-compaction | `system/init → system/status(compacting) → system/compact_boundary(trigger:auto) → user(summary) → assistant → result/success` |
| manual `/compact` | `system/status → system/init → system/compact_boundary(trigger:manual) → user → user(summary) → result/success` (**no assistant** — `/compact` compacts, doesn't generate) |

`rate_limit_event` ordering floats; `system/init` appears every turn (each is a fresh subprocess).

### Settable vs read-only

**Settable — we control these:**

| knob | how | status |
|---|---|---|
| disable auto-compaction | `DISABLE_AUTO_COMPACT=1` (subprocess env) | ✅ verified |
| auto-compaction threshold | `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=N` (% of window) | ✅ verified |
| **compaction prompt** | send **`/compact <instructions>`** as the turn prompt → `trigger:"manual"`, steers the summary | ✅ verified |
| cache TTL | ✖ NOT settable — SDK-internal (~1h `extended_cache_ttl`); no env knob (see the caching section's correction) | ✖ |
| system prompt + static/dynamic split | `systemPrompt` (string[]) + `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` | ✅ |
| model / resume / store | `model`, `resume`, `sessionStore` options | ✅ |
| **max output tokens** | `CLAUDE_CODE_MAX_OUTPUT_TOKENS` (env) | ✅ verified (`scripts/env-knob-probe.ts`) — caps the reply; **don't set absurdly low** (64 errored to empty; use a sane value) |
| **1M context toggle (Opus)** | `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` (env) | ✅ verified — Opus defaults to a **1,000,000** window; the flag drops it to 200k. (Haiku/Sonnet report 200k.) **Now set in `buildClaudeSdkEnv()` (owner default: capped at 200k).** |
| **thinking on/off + mode** | typed `Options.thinking` (`{type:'disabled'\|'adaptive'\|'enabled',budgetTokens}`) — NOT the env var for ON | ✅ — **drive via the typed Option.** `CLAUDE_CODE_DISABLE_THINKING=1` (env) still forces OFF (owner default; verified Sonnet 1→0 blocks); to turn thinking ON the runner clears that env AND sets `thinking:{type:'adaptive'\|'enabled'}`. "adaptive thinking" = `{type:'adaptive'}` (a typed variant, NOT the `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` env). |
| **effort / reasoning level** | typed `Options.effort` (`low\|medium\|high\|xhigh\|max`) — NOT the env var | ✅ verified (`scripts/effort-probe.ts`, since removed) — typed `effort` **bites**: Sonnet low=273ch → high=555ch reasoning (clean dose-response). The `CLAUDE_EFFORT` / `CLAUDE_CODE_EFFORT_LEVEL` **env vars are noise** (no dose-response — wrong lever). **MODEL-GATED (SDK docs):** `xhigh`=Opus 4.7 only; `max`=Opus 4.6/4.7 + Sonnet 4.6 — the SDK clamps unsupported levels (that, plus the wrong lever, is why `CLAUDE_EFFORT=xhigh` on Sonnet looked flat). `CLAUDE_EFFORT` stays neutralized (`undefined`) in `buildClaudeSdkEnv`. |
| **hard cost cap** | typed `Options.maxBudgetUsd` | ✅ — per-query USD ceiling; returns `error_max_budget_usd`. Now exposed via the unified `GenerationParams.maxBudgetUsd`. |
| effective context size | `CLAUDE_CODE_MAX_CONTEXT_TOKENS` (env) | ✖ verified NO effect on the reported `contextWindow` (stayed 200k on haiku) — it is NOT the meter lever; the reported per-model window IS the denominator |
| other compaction env | `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `DISABLE_COMPACT`, `USE_API_CONTEXT_MANAGEMENT`, `CLAUDE_CODE_COLD_COMPACT`, `CLAUDE_AFTER_LAST_COMPACT`, `CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP` | ⚠ candidate |
| inline `settings.autoCompactEnabled` / `autoCompactWindow` | typed `Options.settings` | ✖ did NOT change behavior in test (window=2000 never fired) — **use the env vars instead** |

**Knob discovery + verification probes:** `DISCOVER=1 pnpm sdk:play` dumps every env var the `claude`
binary references (filter: `DISCOVER=cache|context|…`); `scripts/env-knob-probe.ts` runs a real turn per
knob and observes the effect (output cap / reported window / thinking blocks) — that's what promoted the
rows above from candidate to ✅/✖. Re-run after an SDK upgrade.

**One vocab to set them all:** the knobs above aren't set ad-hoc per call — they flow from the SINGLE
provider-agnostic `GenerationParams` (`src/shared/generation.ts`, stored in the preset `config.params`).
Each runner translates it: agent-sdk via `toSdkGeneration` (typed `thinking`/`effort`/`maxBudgetUsd`
Options + env `maxOutputTokens`/`disableThinking`), openrouter via `toReasoningEffort` + request params
(temperature/topP/maxOutputTokens, `reasoning.effort` with `max`→`xhigh`). A knob a runner can't honor
(temperature on agent-sdk; maxBudgetUsd on openrouter) is a documented no-op, so a preset stays portable.

**Read-only — reported back, capture for analytics/UX but can't dictate:**
- `compact_metadata` (stream): `trigger`, `pre_tokens`, `post_tokens`, `duration_ms`.
- `modelUsage` (result): `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`,
  **`contextWindow`**, `maxOutputTokens`, `costUSD`; plus `usage.cache_creation.ephemeral_5m/1h_input_tokens`.
- `rate_limit_info`: `status`, `resetsAt`, `rateLimitType`, `utilization`.
- SDK-stamped frame metadata: `uuid`, `parentUuid`, `logicalParentUuid`, `promptId`, `requestId`, `cwd`,
  `gitBranch`, `version` — we persist verbatim, never author.

**The planned compaction strategy** (not built): `DISABLE_AUTO_COMPACT=1` + watch `contextWindow` per
turn + trigger manual `/compact <RP-tuned instructions>` before the window fills → steered, RP-grade
compaction on the free sub. Env knobs are NOT yet in `buildClaudeSdkEnv()` — that's the build step.

## OpenRouter runner — `@openrouter/sdk` (Chat Completions + Responses)

The non-agent-sdk runner (modes 3 & 4), built on the **official `@openrouter/sdk`** — deliberately
**not** the `openai` package (removed). `providers/openrouter.ts` is the adapter. TWO endpoints, both
returning the provider-agnostic `ChatTurnResult` / throwing `TurnError`:

- **Chat Completions** — `client.chat.send({ chatRequest })` → `runChatCompletionTurn`. The broad
  catalog (mode 3). This is the **cost-controlled paid-Claude path**: for Anthropic models it places a
  **per-block 5m `cache_control` on the STATIC system block** (pins the cache breakpoint at the stable
  prompt → reused every turn) and pins `provider:{order:["Anthropic"]}` so the directive is honored.
- **Responses** — `client.beta.responses.send({ responsesRequest })` → `runRawTurn`. OpenAI-style
  (mode 4). Anthropic gets the top-level `cacheControl` directive; others get a stable `promptCacheKey`.

Plus the live model catalog (`listOpenRouterModels`) + account info (credits/generations/providers/
endpoints) over the rest of the SDK surface — all exposed via tRPC.
- **The Responses API splits `instructions` (system) from `input` (conversation)** — maps onto our
  `assemblePrompt` static/dynamic: static → `instructions` (cached via `promptCacheKey`), conversation → `input`
  items (user/assistant; never start with assistant — pad a user stub). Params (`temperature`/`topP`/penalties/
  `maxOutputTokens`/`reasoning.effort`) flow from the preset config.
- **Typed errors → our `TurnError` kinds** by `statusCode` (the base `OpenRouterError` carries it):
  401/403→auth_failed, 402→billing, 404→model_unavailable, 429→rate_limit, 400/413/422→invalid, 5xx→server,
  connection/timeout→server, abort→aborted. So raw + sdk turns share ONE provider-agnostic boundary + the
  same `ChatTurnResult`.
- **Result (non-streaming):** `output[]` → items `type:"message"` → `content type:"output_text"` → text;
  `usage` = `{inputTokens, outputTokens, totalTokens, inputTokensDetails.cachedTokens, cost}`.
- **Catalog:** `GET /models` is a **public** live catalog (no key) — `listOpenRouterModels` fetches + normalizes
  + caches it; exposed via the `rawModels` tRPC query (`domain/models`).
- **The key:** the valid `OPENROUTER_API_KEY` lives in a gitignored `.env`, loaded by `dotenv` with
  `override:true` (a stale shell export was returning 401 "User not found"). `/models` works without it.
- **Streaming events** (for the future SSE seam): `response.output_text.delta`, `response.reasoning_summary_text.delta`,
  `response.completed` (usage), `response.failed`/`incomplete`. Not wired yet (non-streaming for now).
- The SDK also exposes image-gen + routing metadata + more — for later.

### OpenRouter caching for Anthropic — the working recipe (measured)

`cache_control` is **Anthropic-only** on OpenRouter; non-Anthropic models cache automatically with no
field. `isAnthropicModel(model)` gates it. The SDK DOES type the field as `cacheControl` (camelCase) — no
raw `fetch` needed. The recipe in `providers/openrouter.ts`:
- **Chat Completions (mode 3):** a **per-block `cacheControl` on the STATIC system text block** — this
  pins the breakpoint at the stable system prompt so it's written once and reused every turn. (A
  top-level directive instead pins the breakpoint at the LAST block — the volatile newest user message —
  so no reusable cache forms; measured, `cacheWrite` stayed 0.) The dynamic half goes in a second
  uncached block after it, mirroring sdk-mode's boundary. **5m default TTL** (no `ttl` field): 1h needs
  the `anthropic-beta: extended-cache-ttl` header the SDK doesn't send AND costs ~2× — 5m covers
  back-to-back RP turns cheaply (the ST recipe). Proven: cacheWrite→cacheRead, ~11× cheaper on the read.
- **Responses (mode 4):** the **top-level `cacheControl` directive** for Anthropic; non-Anthropic gets a
  stable `promptCacheKey` (sha1 of model+instructions) so the provider's automatic cache routes consistently.
- **Provider pinning:** for Anthropic we pin `provider:{order:["Anthropic"]}` (order-only, fallbacks stay
  ON) — an UNPINNED Anthropic route can land on an endpoint that silently ignores `cache_control` (measured:
  0 cache). A caller-supplied `providerRouting` (from `chats.metadata`) wins.
- **Min cache thresholds (per model):** Opus 4.7/4.6/4.5 + Haiku 4.5 = **4096 tok**; Sonnet 4.6 = 2048;
  Sonnet 4.5/Opus 4.1 = 1024 — a prefix below the floor won't cache. Cached tokens report as
  `prompt_tokens_details.cached_tokens` → read as `usage.inputTokensDetails.cachedTokens`
  (→ `ChatTurnUsage.cacheReadTokens`).
- **Sticky routing:** after a cached request OpenRouter keeps the provider warm → DON'T churn `provider`
  routing between turns. (History-depth breakpoints à la ST → a later refinement, #48.)

**Other Responses best practices for Anthropic (the SDK DOES type these — usable now):**
- `reasoning` (ReasoningConfig: `effort` xhigh/high/medium/low/minimal/none, `enabled`, `maxTokens`, `summary`).
  Mirror the sdk-mode owner default → raw Claude should default reasoning OFF/minimal (paid per token).
- `provider` (ProviderPreferences) — already wired (`providerRouting`).
- `previousResponseId` — server-side conversation state (alt to rebuilding `input` each turn); we prefer
  canon-rebuild + caching (keeps us in control), so skip unless a reason appears.
- `X-OpenRouter-Experimental-Metadata: enabled` header → `openrouter_metadata` (routing/cost) for observability.
- Specify `max_output_tokens`/`temperature` explicitly (no model defaults) — done via preset params.

**sdk-mode swipe caching — MEASURED (`scripts/sdk-cache-probe.sh`, live):** a swipe re-seeds a FRESH session,
but the static character prefix is content-addressed (1h TTL) so it SURVIVES: send `cacheCreate=2901`/`cacheRead=0`
→ swipe `cacheRead=2901` (hits!) → next send `cacheRead=2901`. The re-seed model is **cache-cheap** — only the
small new tail re-caches. (Validated the 5E re-seed design.)
