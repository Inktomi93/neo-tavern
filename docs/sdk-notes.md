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
*placement*, but the **TTL is controllable via env vars** read by the `claude`
binary (found by `strings` on the executable — NOT in the typed `Options`, but we
set the subprocess env in `buildClaudeSdkEnv()`):

- `FORCE_PROMPT_CACHING_5M` → 5-minute cache
- `ENABLE_PROMPT_CACHING_1H` (+ `_BEDROCK`) → 1-hour cache
- `DISABLE_PROMPT_CACHING` (+ `_HAIKU` / `_OPUS` / `_SONNET`) → off

**Sub-mode default TTL is 1h** (measured — the runtime opts in; the raw-API default
of 5m does not apply here). For human-paced RP that's the *right* default: step away
40 min, come back, and the character/system prefix is still a cache hit. So we leave
it at 1h in sdk-mode; 5m only helps in raw-mode where you pay per write and churn
fast. **No change to `buildClaudeSdkEnv()` needed** — 1h is already on.

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
- **Editing a buried turn** diverges the prefix at the edit point → everything
  after re-caches (cost ∝ tail length). *Reasoned from prefix mechanics, NOT yet
  measured here* — the truncation test only proves prefixes stay cached.
- The expensive static prefix (character/system) is paid **once** and read free
  thereafter, including across forks — so YGWYG's append-only path is also the
  cache-optimal path.

Not covered by this probe (honest gaps): **actual TTL expiry** (proved which bucket
via `cache_creation`, didn't wait out the window — a chat reopened after it is a
cold first turn regardless); **mid-history edit divergence**; **raw-mode** (separate
path, our own `cache_control`). Numbers are Haiku-specific; mechanics are
model-independent.

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
- **Edit a buried frame** (change content, resume) — the identical `load()` mechanism,
  so it works; the only open question is its **cache cost** (mid-history divergence
  re-caches the tail), the one thing we flagged-but-didn't-measure. `EDIT` probe TODO.
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
