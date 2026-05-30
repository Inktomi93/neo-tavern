import type { ChatApi, ChatSource } from "../../../shared/chat-routing";
import type {
  CharacterId,
  CharacterVersionId,
  ChatId,
  MessageId,
  PersonaId,
  PresetId,
  PresetVersionId,
} from "../../../shared/ids";
import type { TurnErrorKind } from "../../providers/turn";
import { DomainNotFoundError, DomainOperationError } from "../_shared/errors";

// The chat-routing vocabulary now lives in one place (shared/chat-routing.ts) — re-exported here so
// existing importers of ChatApi/ChatSource from this module keep working unchanged.
export type { ChatApi, ChatSource };

// Shaped, client-safe view of a message row. Carries the per-turn provenance the chat UI needs
// (the context-fill meter off contextWindow, a cost/latency readout, the edited marker) — the
// columns the old lean projection hid. Metadata only; never any non-message column.
// These columns track the ACTIVE variant (mirrored on swipe/select). The token/model/provider are
// kept exact per variant; the richer cost/context/cache/ttft fields reflect the latest GENERATION
// (not yet stored per variant — message_variants holds the per-gen record).
export interface MessageView {
  id: MessageId;
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
  id: ChatId;
  title: string;
  characterName: string | null;
  avatarHash: string | null;
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
  characterId: CharacterId | null;
  characterVersionId: CharacterVersionId;
  personaId: PersonaId | null; // the ACTIVE persona (user-field {{user}})
  pinnedPersonaId: PersonaId | null; // the persona pinned at open (card {{user}}); null → falls back to personaId
  presetVersionId: PresetVersionId | null;
  parentChatId: ChatId | null;
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

// Lazy chat creation. A chat row is written only at the FIRST canon-producing action — either the
// user's first message (`firstUserMessage`) or `generateOpening` (the model writes the opening).
// The new-chat *draft* (which character/persona/preset/provider, seeded from the user's settings)
// lives CLIENT-side until then; this is the commit. References an EXISTING character version (the
// `character` domain owns library entities — chat-start no longer creates characters inline).
export interface StartChatParams {
  username: string;
  // Client-supplied UUID so the client can subscribe to streamMessages before the first turn runs.
  // Omitted → generated server-side.
  chatId?: ChatId | undefined;
  // The existing character version this chat is with (owner-scoped). Required.
  characterVersionId: CharacterVersionId;
  // Defaults to the character's name when omitted.
  title?: string | undefined;
  // Seeds (caller arg → user-settings default → schema/runtime default). A stale/unowned preset or
  // persona id degrades to null (never fails creation). `presetId` is a preset IDENTITY (resolved to
  // its current version). `max-pro-sub` is the owner's credential — guarded for non-owners.
  personaId?: PersonaId | undefined;
  presetId?: PresetId | undefined;
  api?: ChatApi | undefined;
  source?: ChatSource | undefined;
  model?: string | null | undefined;
  /** Browser IANA timezone for {{time}}/{{date}} on the first turn (Intl…timeZone). Absent → server-local. */
  timezone?: string | undefined;
  // Which of the character version's greetings opens the chat (default 0). The greeting becomes seq 1
  // and is persisted together with the first user message. Ignored on the `generateOpening` path.
  greetingIndex?: number | undefined;
  // Exactly ONE commit trigger must be set:
  //  • firstUserMessage — the user's opening line; runs the first turn (any provider).
  //  • generateOpening   — the model writes seq 1 in-character (no user message; any provider).
  firstUserMessage?: string | undefined;
  generateOpening?: boolean | undefined;
}

export interface StartChatResult {
  chatId: ChatId;
  result: SendResult;
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
    staticTokens: number;
    dynamicTokens: number;
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
  chatId: ChatId;
  /** The client's last-seen tip (MAX seq it knows). Mismatch → "stale". */
  expectedSeq: number;
  content: string;
  /** Browser IANA timezone for {{time}}/{{date}} this turn (Intl…timeZone). Absent → server-local. */
  timezone?: string | undefined;
}

export interface ForkChatParams {
  username: string;
  chatId: ChatId;
  /** Branch point: copy canon messages with seq ≤ atSeq into the new chat. */
  atSeq: number;
  /** The fork's api + source. agent-sdk targets seed session_entries from the copied canon;
   *  openrouter-runner targets (responses) rebuild from canon (no session). */
  targetApi: ChatApi;
  targetSource: ChatSource;
}

export interface SetProviderParams {
  username: string;
  chatId: ChatId;
  /** The api/source to switch this chat to (the generalized escape valve). Switching INTO agent-sdk
   *  seeds a session from canon; switching OUT drops it; max↔openrouter keeps the session. */
  api: ChatApi;
  source: ChatSource;
  /** New next-turn model, or null/undefined to fall back to the resolver default for the target. */
  model?: string | null | undefined;
}

export interface SwipeParams {
  username: string;
  chatId: ChatId;
  /** The chat's current MAX seq (swipe MUTATES the tip — it does NOT advance seq). Mismatch → stale. */
  expectedSeq: number;
  /** Browser IANA timezone for {{time}}/{{date}} this turn (Intl…timeZone). Absent → server-local. */
  timezone?: string | undefined;
}

export interface SelectVariantParams {
  username: string;
  chatId: ChatId;
  messageId: MessageId;
  /** Which existing swipe to make active. */
  variantIdx: number;
}

export interface EditMessageParams {
  username: string;
  chatId: ChatId;
  messageId: MessageId;
  content: string;
}

export interface CompactParams {
  username: string;
  chatId: ChatId;
  /** RP-tuned /compact steering; falls back to the preset's compaction.instructions, then a default. */
  instructions?: string | undefined;
}

export interface ChatService {
  /** Lazy creation: scaffold the chat from an existing character version + seeded defaults, then run
   *  the FIRST turn (the user's message, or a generated opening). The only canon-creating entry. */
  startChat(params: StartChatParams): Promise<StartChatResult>;
  /** The caller's chats, newest-updated first (owner-scoped). Drives the chat-list rail. */
  listChats(params: { username: string }): Promise<ChatSummary[]>;
  /** One owned chat's metadata (summary + pins/links). Throws ChatNotFoundError if unowned. */
  getChat(params: { username: string; chatId: ChatId }): Promise<ChatDetail>;
  /** Dry-run: what the next turn's prompt + routing would be, without generating. */
  previewAssembly(params: { username: string; chatId: ChatId }): Promise<AssemblyPreview>;
  listMessages(params: { username: string; chatId: ChatId }): Promise<MessageView[]>;
  send(params: SendParams): Promise<SendResult>;
  /** Switch a chat's api/source/model in place (the generalized escape valve). Handles the session
   *  implications (seed when entering agent-sdk, drop when leaving). Throws on an incoherent combo. */
  setProvider(params: SetProviderParams): Promise<void>;
  /** Branch a chat at `atSeq` into a new chat (parentChatId/forkedAt). Returns the new id. */
  forkChat(params: ForkChatParams): Promise<{ chatId: ChatId }>;
  /** Regenerate the last assistant turn as a NEW variant (swipe). Returns the same result shape as
   *  send (ok / stale / error) — a swipe is a generation, so it can be stale or fail like any turn. */
  swipe(params: SwipeParams): Promise<SendResult>;
  /** Make an existing variant active (swipe ← →). No model call. */
  selectVariant(params: SelectVariantParams): Promise<MessageView[]>;
  /** Edit a message's content in place (+ the active variant). No model call; re-seeds the sdk session. */
  editMessage(params: EditMessageParams): Promise<MessageView[]>;
  // (compact/delete/updateTitle/star/archive below take ChatId)
  /** Manually compact an agent-sdk chat's session (steered `/compact`). No-op (compacted:false) for
   *  openrouter chats or a chat with no session yet. The lever for compaction mode "off". */
  compact(params: CompactParams): Promise<{ compacted: boolean }>;
  delete(params: { username: string; chatId: ChatId }): Promise<{ deleted: boolean }>;
  updateTitle(params: { username: string; chatId: ChatId; title: string }): Promise<void>;
  star(params: { username: string; chatId: ChatId; starred: boolean }): Promise<void>;
  archive(params: { username: string; chatId: ChatId; archived: boolean }): Promise<void>;
}

// Thrown when a chat doesn't exist or isn't owned by the caller. The trpc layer maps
// this to a NOT_FOUND error (domain can't import @trpc/server — wrong direction).
export class ChatNotFoundError extends DomainNotFoundError {
  constructor(chatId: ChatId) {
    super("Chat", chatId);
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
export class ChatOperationError extends DomainOperationError {
  readonly reason: ChatOpReason;
  constructor(reason: ChatOpReason, message: string) {
    super(reason, message);
    this.reason = reason;
  }
}
