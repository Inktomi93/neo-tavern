/**
 * Selectable chat models — the latest Claude model per tier. The toggle and the
 * default both read from THIS list, so "latest" stays a one-line edit: bump an
 * id here when a newer model ships and everything downstream follows.
 *
 * These run through the Claude Agent SDK (sdk-mode chats). Non-Claude models
 * arrive via OpenRouter alongside raw mode in a later phase.
 */
export const CHAT_MODELS = [
  { id: "claude-opus-4-7", tier: "opus", label: "Opus 4.7" },
  { id: "claude-sonnet-4-6", tier: "sonnet", label: "Sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001", tier: "haiku", label: "Haiku 4.5" },
] as const;

export type ChatModelId = (typeof CHAT_MODELS)[number]["id"];

/** Default until the user toggles (answers the brief's open model question). */
export const DEFAULT_CHAT_MODEL_ID: ChatModelId = "claude-opus-4-7";
