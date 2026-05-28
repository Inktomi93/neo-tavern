// Public API (front door) for the chat domain feature.

export { createChatService } from "./service";
export { chatStreamEmitter } from "./stream";
export type {
  ChatService,
  CreateChatParams,
  ForkChatParams,
  MessageView,
  SendParams,
  SendResult,
} from "./types";
export { ChatNotFoundError, ChatOperationError } from "./types";
