// Shaped, client-safe view of a message row (we don't leak every column).
export interface MessageView {
  id: string;
  seq: number;
  role: "user" | "assistant" | "system";
  content: string;
  model: string | null;
  createdAt: number;
}

// send() result. "stale" = the optimistic seq guard tripped (another device advanced
// the chat); we return the current messages so the caller re-syncs (reconcile or fork).
export type SendResult =
  | { status: "ok"; messages: MessageView[] }
  | { status: "stale"; messages: MessageView[]; latestSeq: number };

export interface CreateChatParams {
  username: string;
  title: string;
  characterName: string;
  characterDescription: string;
  // `| undefined` (not bare optional) so a spread carrying `firstMessage: undefined`
  // satisfies exactOptionalPropertyTypes.
  firstMessage?: string | undefined;
}

export interface SendParams {
  username: string;
  chatId: string;
  /** The client's last-seen tip (MAX seq it knows). Mismatch → "stale". */
  expectedSeq: number;
  content: string;
}

export interface ChatService {
  create(params: CreateChatParams): Promise<{ chatId: string }>;
  listMessages(params: { username: string; chatId: string }): Promise<MessageView[]>;
  send(params: SendParams): Promise<SendResult>;
}

// Thrown when a chat doesn't exist or isn't owned by the caller. The trpc layer maps
// this to a NOT_FOUND error (domain can't import @trpc/server — wrong direction).
export class ChatNotFoundError extends Error {
  constructor(chatId: string) {
    super(`chat not found: ${chatId}`);
    this.name = "ChatNotFoundError";
  }
}
