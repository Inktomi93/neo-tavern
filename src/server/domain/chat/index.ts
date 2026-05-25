// Public API (front door) for the chat domain feature.
export { createChatService } from "./service";
export type { ChatService, CreateChatParams, MessageView, SendParams, SendResult } from "./types";
export { ChatNotFoundError } from "./types";
