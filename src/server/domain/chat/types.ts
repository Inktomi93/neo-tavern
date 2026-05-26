import type { TurnErrorKind } from "../../providers/turn";

// Shaped, client-safe view of a message row. Carries the per-turn provenance the chat UI needs
// (the context-fill meter off contextWindow, a cost/latency readout, the edited marker) — the
// columns the old lean projection hid. Metadata only; never any non-message column.
// These columns track the ACTIVE variant (mirrored on swipe/select). The token/model/provider are
// kept exact per variant; the richer cost/context/cache/ttft fields reflect the latest GENERATION
// (not yet stored per variant — message_variants holds the per-gen record).
export interface MessageView {
  id: string;
  seq: number;
  role: "user" | "assistant" | "system";
  content: string; // the ACTIVE variant's text (= variants[activeVariantIdx].content) when variants exist
  model: string | null;
  provider: string | null;
  stopReason: string | null;
  /** Normalized cross-mode finish reason ("length" = truncated, etc.) — drives a UI indicator. */
  finishReason: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  contextWindow: number | null;
  costUsd: number | null;
  ttftMs: number | null;
  terminalReason: string | null;
  createdAt: number;
  editedAt: number | null;
  /** Which swipe is shown; null = single generation (no variants). */
  activeVariantIdx: number | null;
  /** Total swipes for this message (0 = single generation). Drives the "3 / 5" counter. */
  variantCount: number;
}

// Chat list-row view (chat.list) — what the chat-list rail renders. Owner-scoped, newest first.
export interface ChatSummary {
  id: string;
  title: string;
  characterName: string | null;
  api: ChatApi;
  source: ChatSource;
  model: string | null;
  messageCount: number;
  totalTokensIn: number;
  totalTokensOut: number;
  starred: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

// Single-chat view (chat.get) — the summary + the pins/links the chat header + provider picker need.
export interface ChatDetail extends ChatSummary {
  characterId: string | null;
  characterVersionId: string;
  personaId: string | null; // the ACTIVE persona (user-field {{user}})
  pinnedPersonaId: string | null; // the persona pinned at open (card {{user}}); null → falls back to personaId
  presetVersionId: string | null;
  parentChatId: string | null;
  forkedAt: number | null;
  /** Whether an agent-sdk resume session exists (the raw uuid isn't useful to the client). */
  hasSession: boolean;
}

// send() result. A discriminated union the client renders directly.
//  - "stale": the optimistic seq guard tripped (another device advanced the chat); we
//    return the current messages so the caller re-syncs (reconcile or fork).
//  - "error": the generation failed. `code` is the PROVIDER-AGNOSTIC reason (the same
//    vocabulary raw-mode will use in Phase 5), `retryable` says whether re-sending could
//    work, `resetsAt` (rate_limit only) is when the window reopens. The user message is
//    rolled back, so `messages` is the chat's prior coherent tip — re-send to retry.
export type SendResult =
  | { status: "ok"; messages: MessageView[] }
  | { status: "stale"; messages: MessageView[]; latestSeq: number }
  | {
      status: "error";
      code: TurnErrorKind;
      retryable: boolean;
      resetsAt?: number;
      messages: MessageView[];
    };

export interface CreateChatParams {
  username: string;
  title: string;
  characterName: string;
  characterDescription: string;
  // `| undefined` (not bare optional) so a spread carrying `firstMessage: undefined`
  // satisfies exactOptionalPropertyTypes.
  firstMessage?: string | undefined;
  // What to do when there's NO greeting (firstMessage empty). false (default) = the chat starts
  // blank and the USER speaks first. true = "generate to open": the model writes the opening
  // message in-character (a no-user-message turn). A per-chat toggle because auto-opening isn't
  // always wanted. Ignored when firstMessage is set (that greeting is always used).
  generateOpeningIfEmpty?: boolean | undefined;
}

// Dry-run prompt assembly for a chat — what the NEXT turn would send, WITHOUT spending a turn.
// Owner-scoped (you preview your own chat); returns the assembled system prompt + the trace
// (which world-info fired, section breakdown, cached-prefix size) + the resolved routing.
export interface AssemblyPreview {
  routing: { runner: string; api: ChatApi; source: ChatSource; model: string };
  preset: "default" | "pinned";
  /** The assembled system prompt halves (static = cached prefix, dynamic = per-turn suffix). */
  systemPrompt: { static: string; dynamic: string };
  trace: {
    staticChars: number;
    dynamicChars: number;
    staticSections: string[];
    dynamicSections: string[];
    worldInfoAttached: number;
    worldInfoIncluded: number;
    matchedKeys: string[];
    hasPersona: boolean;
  };
}

export interface SendParams {
  username: string;
  chatId: string;
  /** The client's last-seen tip (MAX seq it knows). Mismatch → "stale". */
  expectedSeq: number;
  content: string;
}

/** The api/source a chat runs as (matches chats.api/source; see domain/chat/routing). */
export type ChatApi = "agent-sdk" | "chat-completions" | "responses";
export type ChatSource = "max-pro-sub" | "openrouter";

export interface ForkChatParams {
  username: string;
  chatId: string;
  /** Branch point: copy canon messages with seq ≤ atSeq into the new chat. */
  atSeq: number;
  /** The fork's api + source. agent-sdk targets seed session_entries from the copied canon;
   *  openrouter-runner targets (responses) rebuild from canon (no session). */
  targetApi: ChatApi;
  targetSource: ChatSource;
}

export interface SetProviderParams {
  username: string;
  chatId: string;
  /** The api/source to switch this chat to (the generalized escape valve). Switching INTO agent-sdk
   *  seeds a session from canon; switching OUT drops it; max↔openrouter keeps the session. */
  api: ChatApi;
  source: ChatSource;
  /** New next-turn model, or null/undefined to fall back to the resolver default for the target. */
  model?: string | null | undefined;
}

export interface SwipeParams {
  username: string;
  chatId: string;
  /** The chat's current MAX seq (swipe MUTATES the tip — it does NOT advance seq). Mismatch → stale. */
  expectedSeq: number;
}

export interface SelectVariantParams {
  username: string;
  chatId: string;
  messageId: string;
  /** Which existing swipe to make active. */
  variantIdx: number;
}

export interface EditMessageParams {
  username: string;
  chatId: string;
  messageId: string;
  content: string;
}

export interface CompactParams {
  username: string;
  chatId: string;
  /** RP-tuned /compact steering; falls back to the preset's compaction.instructions, then a default. */
  instructions?: string | undefined;
}

export interface ChatService {
  create(params: CreateChatParams): Promise<{ chatId: string }>;
  /** The caller's chats, newest-updated first (owner-scoped). Drives the chat-list rail. */
  listChats(params: { username: string }): Promise<ChatSummary[]>;
  /** One owned chat's metadata (summary + pins/links). Throws ChatNotFoundError if unowned. */
  getChat(params: { username: string; chatId: string }): Promise<ChatDetail>;
  /** Dry-run: what the next turn's prompt + routing would be, without generating. */
  previewAssembly(params: { username: string; chatId: string }): Promise<AssemblyPreview>;
  listMessages(params: { username: string; chatId: string }): Promise<MessageView[]>;
  send(params: SendParams): Promise<SendResult>;
  /** Switch a chat's api/source/model in place (the generalized escape valve). Handles the session
   *  implications (seed when entering agent-sdk, drop when leaving). Throws on an incoherent combo. */
  setProvider(params: SetProviderParams): Promise<void>;
  /** Branch a chat at `atSeq` into a new chat (parentChatId/forkedAt). Returns the new id. */
  forkChat(params: ForkChatParams): Promise<{ chatId: string }>;
  /** Regenerate the last assistant turn as a NEW variant (swipe). Returns the same result shape as
   *  send (ok / stale / error) — a swipe is a generation, so it can be stale or fail like any turn. */
  swipe(params: SwipeParams): Promise<SendResult>;
  /** Make an existing variant active (swipe ← →). No model call. */
  selectVariant(params: SelectVariantParams): Promise<MessageView[]>;
  /** Edit a message's content in place (+ the active variant). No model call; re-seeds the sdk session. */
  editMessage(params: EditMessageParams): Promise<MessageView[]>;
  /** Manually compact an agent-sdk chat's session (steered `/compact`). No-op (compacted:false) for
   *  openrouter chats or a chat with no session yet. The lever for compaction mode "off". */
  compact(params: CompactParams): Promise<{ compacted: boolean }>;
}

// Thrown when a chat doesn't exist or isn't owned by the caller. The trpc layer maps
// this to a NOT_FOUND error (domain can't import @trpc/server — wrong direction).
export class ChatNotFoundError extends Error {
  constructor(chatId: string) {
    super(`chat not found: ${chatId}`);
    this.name = "ChatNotFoundError";
  }
}

// A chat operation that's invalid for the chat's current state. `reason` lets the transport map it
// to the right error code without importing @trpc/server into the domain (wrong direction).
export type ChatOpReason =
  | "invalid_provider"
  | "invalid_fork_point"
  | "no_such_message"
  | "no_such_variant"
  | "not_swipeable";
export class ChatOperationError extends Error {
  readonly reason: ChatOpReason;
  constructor(reason: ChatOpReason, message: string) {
    super(message);
    this.name = "ChatOperationError";
    this.reason = reason;
  }
}
