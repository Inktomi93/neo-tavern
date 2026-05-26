import type { TurnErrorKind } from "../../providers/turn";

// Shaped, client-safe view of a message row (we don't leak every column).
export interface MessageView {
  id: string;
  seq: number;
  role: "user" | "assistant" | "system";
  content: string;
  model: string | null;
  createdAt: number;
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

export interface SendParams {
  username: string;
  chatId: string;
  /** The client's last-seen tip (MAX seq it knows). Mismatch → "stale". */
  expectedSeq: number;
  content: string;
}

export interface ForkChatParams {
  username: string;
  chatId: string;
  /** Branch point: copy canon messages with seq ≤ atSeq into the new chat. */
  atSeq: number;
  /** The fork's mode. 'raw' rebuilds history from canon (supported); 'sdk' needs
   *  session_entries seeding (deferred — throws until the seeding primitive lands). */
  targetMode: "sdk" | "raw";
}

export interface ChatService {
  create(params: CreateChatParams): Promise<{ chatId: string }>;
  listMessages(params: { username: string; chatId: string }): Promise<MessageView[]>;
  send(params: SendParams): Promise<SendResult>;
  /** One-way sdk→raw conversion, in place (CLAUDE.md escape valve). Throws if not sdk. */
  convertToRaw(params: { username: string; chatId: string }): Promise<void>;
  /** Branch a chat at `atSeq` into a new chat (parentChatId/forkedAt). Returns the new id. */
  forkChat(params: ForkChatParams): Promise<{ chatId: string }>;
}

// Thrown when a chat doesn't exist or isn't owned by the caller. The trpc layer maps
// this to a NOT_FOUND error (domain can't import @trpc/server — wrong direction).
export class ChatNotFoundError extends Error {
  constructor(chatId: string) {
    super(`chat not found: ${chatId}`);
    this.name = "ChatNotFoundError";
  }
}

// A chat operation that's invalid for the chat's current state, or not yet implemented.
// `reason` lets the transport pick the right code (BAD_REQUEST vs NOT_IMPLEMENTED) without
// importing @trpc/server into the domain. fork_sdk_unsupported = the deferred raw→sdk
// seeding primitive (shared with greeting seeding); see docs/build-plan.md.
export type ChatOpReason = "not_sdk" | "invalid_fork_point";
export class ChatOperationError extends Error {
  readonly reason: ChatOpReason;
  constructor(reason: ChatOpReason, message: string) {
    super(message);
    this.name = "ChatOperationError";
    this.reason = reason;
  }
}
