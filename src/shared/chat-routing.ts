import { z } from "zod";

// The canonical home for the chat-routing tuple's vocabulary — the `api` (wire protocol / runner)
// and `source` (which credential/provider backs it) that, with the model, decide a chat's next-turn
// routing (see CLAUDE.md's 4-mode table + domain/chat/routing `resolveTurnRouting`). Previously these
// values were spelled in three places (the literal types in domain/chat/types.ts and the inline
// `text(enum:[…])` columns in db/schema/chats.ts); this is the single source so the zod schemas
// (user-settings, tRPC inputs) and the TS types agree by construction.

export const CHAT_APIS = ["agent-sdk", "chat-completions", "responses"] as const;
export type ChatApi = (typeof CHAT_APIS)[number];
export const chatApiSchema = z.enum(CHAT_APIS);

export const CHAT_SOURCES = ["max-pro-sub", "openrouter"] as const;
export type ChatSource = (typeof CHAT_SOURCES)[number];
export const chatSourceSchema = z.enum(CHAT_SOURCES);
