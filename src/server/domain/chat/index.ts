// Public API (front door) for the chat domain feature.

export type { ChatServiceDeps } from "./service";
export { createChatService } from "./service";
export { chatStreamEmitter } from "./stream";
export type {
  ChatService,
  ForkChatParams,
  MessageView,
  SendParams,
  SendResult,
  StartChatParams,
  StartChatResult,
} from "./types";
export { ChatNotFoundError, ChatOperationError } from "./types";
