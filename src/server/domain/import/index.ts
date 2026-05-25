// Public API (front door) for the import domain feature: SillyTavern corpus → our schema.
// Pure parsers (card/chat) + the orchestration service that maps parsed structures to
// characters / versions / chats / messages / message_variants / world rows. The jobs-layer
// runner (pnpm import:st) walks the staged files and drives this through the front door.

export { type ParsedCard, parseCardPng } from "./card";
export {
  type ChatBucket,
  type MessageRole,
  type ParsedChat,
  type ParsedChatMessage,
  type ParsedVariant,
  parseChatJsonl,
  parseStDate,
} from "./chat";
export { type CollectResult, collectBundlesFromDir } from "./loader";
export {
  createImportService,
  type ImportCardInput,
  type ImportCharacterInput,
  type ImportCharacterResult,
  type ImportChatInput,
  type ImportService,
  type ImportServiceDeps,
  slugifyHandle,
} from "./service";
