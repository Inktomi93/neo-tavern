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
3. **The literal request body is NOT exposed.** Tried `debug`, the `stderr`
   callback, `debugFile`, and `ANTHROPIC_LOG=debug` — the bundled runtime logs
   request *metadata* (endpoint, source, request id) but never the assembled
   system prompt / messages. The only way to see the literal bytes is **HTTP
   wire-capture** (route the subprocess via a logging proxy), which is fragile
   with sub-OAuth — not built, and the canary + audit make it rarely necessary.

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

## How this maps to neo-tavern

- **sdk-mode chat** = `query({ prompt, options: { resume: chat.sessionId, … } })`,
  persist `result.session_id` on the chat row. Append-only = each turn resumes.
- **Escape-valve fork** = `forkSession(sessionId)` → new resumable session.
- **Token/cost accounting** for the `messages` table = the `result.modelUsage` block.
- **Streaming to the client** = forward `stream_event` deltas.
- **Debugging a bad turn** = `DEBUG=1 pnpm sdk:play` with the offending prompt, or
  the app's own `/api/_debug` (see `observability.md`).
